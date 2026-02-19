const express     = require('express');
const cors        = require('cors');
const Database    = require('better-sqlite3');
const bcrypt      = require('bcryptjs');
const PDFDocument = require('pdfkit');
const fs          = require('fs');
const path        = require('path');

const app  = express();
const PORT = 3001;

// ==================== MIDDLEWARE ====================
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ==================== DATABASE SETUP ====================
const dbDir  = path.join(__dirname, '..', 'database');
const dbPath = path.join(dbDir, 'quickride.db');

// Create folder if missing
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
    console.log('✅ Created database directory:', dbDir);
}

let db;
try {
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    console.log('✅ Database connected:', dbPath);
} catch (err) {
    console.error('❌ Cannot open database:', err.message);
    process.exit(1);
}

// ==================== SCHEMA ====================
function initializeDatabase() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS shareholders (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            full_name        TEXT    NOT NULL,
            father_name      TEXT    NOT NULL DEFAULT '',
            address          TEXT    NOT NULL,
            pin_code         TEXT    NOT NULL DEFAULT '',
            phone            TEXT    NOT NULL,
            email            TEXT    NOT NULL UNIQUE,
            business_role    TEXT    NOT NULL,
            num_shares       INTEGER NOT NULL DEFAULT 0,
            username         TEXT    NOT NULL UNIQUE,
            password_hash    TEXT    NOT NULL,
            photo_data       TEXT,
            signature_data   TEXT,
            total_investment REAL    NOT NULL DEFAULT 0,
            price_per_share  REAL    NOT NULL DEFAULT 1200,
            stage            INTEGER NOT NULL DEFAULT 2,
            status           TEXT    NOT NULL DEFAULT 'PENDING',
            created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
            approved_at      TEXT
        );

        CREATE TABLE IF NOT EXISTS subscriber_counts (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            business_role TEXT    NOT NULL UNIQUE,
            count         INTEGER NOT NULL DEFAULT 0,
            updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS dividend_history (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            shareholder_id INTEGER NOT NULL REFERENCES shareholders(id),
            month          TEXT    NOT NULL,
            amount         REAL    NOT NULL,
            status         TEXT    NOT NULL DEFAULT 'PAID',
            paid_at        TEXT    NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS role_prices (
            business_role TEXT NOT NULL PRIMARY KEY,
            price         REAL NOT NULL DEFAULT 350,
            updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS investment_stages (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            stage            INTEGER NOT NULL,
            name             TEXT    NOT NULL,
            price_per_share  REAL    NOT NULL,
            min_subscribers  INTEGER NOT NULL,
            max_subscribers  INTEGER NOT NULL,
            status           TEXT    NOT NULL,
            shares_available INTEGER NOT NULL DEFAULT 0
        );
    `);

    // Check if signature_data column exists, if not add it
    const tableInfo = db.prepare("PRAGMA table_info(shareholders)").all();
    const hasSignatureColumn = tableInfo.some(col => col.name === 'signature_data');
    if (!hasSignatureColumn) {
        db.exec(`ALTER TABLE shareholders ADD COLUMN signature_data TEXT`);
        console.log('✅ Added signature_data column to shareholders table');
    }

    // Seed subscriber roles
    const insertRole = db.prepare(
        `INSERT OR IGNORE INTO subscriber_counts (business_role, count) VALUES (?, 0)`
    );
    ['DRIVER', 'TRAVEL_AGENT', 'SHOPS_HOTELS'].forEach(r => insertRole.run(r));

    // Seed default role prices
    const insertPrice = db.prepare(
        `INSERT OR IGNORE INTO role_prices (business_role, price) VALUES (?, ?)`
    );
    insertPrice.run('DRIVER',       350);
    insertPrice.run('TRAVEL_AGENT', 500);
    insertPrice.run('SHOPS_HOTELS', 700);

    // Seed investment stages
    if (db.prepare(`SELECT COUNT(*) AS n FROM investment_stages`).get().n === 0) {
        const ins = db.prepare(`
            INSERT INTO investment_stages
            (stage, name, price_per_share, min_subscribers, max_subscribers, status, shares_available)
            VALUES (?,?,?,?,?,?,?)
        `);
        db.transaction(() => {
            ins.run(1, 'Base Price',    1000, 0,    1500,  'SOLD_OUT', 0  );
            ins.run(2, 'Current Price', 1200, 1501, 5000,  'RUNNING',  100);
            ins.run(3, 'Next Price',    1440, 5001, 15000, 'UPCOMING', 100);
        })();
        console.log('✅ Investment stages seeded');
    }

    // Seed admin user
    if (!db.prepare(`SELECT id FROM shareholders WHERE username = 'admin'`).get()) {
        const hash = bcrypt.hashSync('admin123', 10);
        db.prepare(`
            INSERT INTO shareholders
            (full_name, father_name, address, pin_code, phone, email,
             business_role, num_shares, username, password_hash,
             total_investment, status)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(
            'Administrator', '', 'Quick Ride HQ', '000000',
            '+91 00000 00000', 'admin@quickride.com',
            'ADMIN', 0, 'admin', hash, 0, 'APPROVED'
        );
        console.log('✅ Admin created  →  username: admin  |  password: admin123');
    } else {
        // Always ensure admin is APPROVED
        db.prepare(`UPDATE shareholders SET status = 'APPROVED' WHERE username = 'admin'`).run();
    }
    console.log('✅ Database ready');
}

initializeDatabase();

// ==================== HELPERS ====================
const getRunningStage = () =>
    db.prepare(`SELECT * FROM investment_stages WHERE status = 'RUNNING'`).get()
    || { price_per_share: 1200, stage: 2, name: 'Current Price' };

// ==================== API ROUTES ====================

// POST /api/agreements - Register new investor
app.post('/api/agreements', (req, res) => {
    try {
        console.log('Received agreement submission:', req.body);
        
        const {
            fullName,
            fatherName,
            address,
            phone,
            email,
            businessRole,
            numShares,
            username,
            password,
            photoData,
            investorSignature
        } = req.body;

        // Validate required fields
        if (!fullName || !address || !phone || !email || !username || !password || !numShares) {
            console.log('Missing required fields');
            return res.status(400).json({ 
                success: false, 
                message: 'Missing required fields' 
            });
        }

        // Check if username already exists
        const existingUser = db.prepare('SELECT id FROM shareholders WHERE username = ?').get(username);
        if (existingUser) {
            console.log('Username already taken:', username);
            return res.status(400).json({ 
                success: false, 
                message: 'Username already taken' 
            });
        }

        // Check if email already exists
        const existingEmail = db.prepare('SELECT id FROM shareholders WHERE email = ?').get(email);
        if (existingEmail) {
            console.log('Email already registered:', email);
            return res.status(400).json({ 
                success: false, 
                message: 'Email already registered' 
            });
        }

        // Get current stage for price
        const currentStage = db.prepare(`
            SELECT * FROM investment_stages WHERE status = 'RUNNING'
        `).get() || { price_per_share: 1200, stage: 2 };

        const pricePerShare = currentStage.price_per_share;
        const totalInvestment = numShares * pricePerShare;

        // Hash password
        const passwordHash = bcrypt.hashSync(password, 10);

        // Insert shareholder
        const insert = db.prepare(`
            INSERT INTO shareholders (
                full_name, father_name, address, pin_code, phone, email,
                business_role, num_shares, username, password_hash,
                photo_data, signature_data, total_investment, price_per_share, stage,
                status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const result = insert.run(
            fullName,
            fatherName || '',
            address,
            '', // pin_code (optional for now)
            phone,
            email,
            businessRole || 'DRIVER',
            numShares,
            username,
            passwordHash,
            photoData || null,
            investorSignature || null,
            totalInvestment,
            pricePerShare,
            currentStage.stage,
            'PENDING',
            new Date().toISOString()
        );

        console.log(`✅ New investor registered: ${fullName} (ID: ${result.lastInsertRowid})`);

        res.json({
            success: true,
            message: 'Agreement submitted successfully',
            id: result.lastInsertRowid
        });

    } catch (err) {
        console.error('POST /api/agreements error:', err.message);
        console.error(err.stack);
        res.status(500).json({ 
            success: false, 
            message: 'Server error: ' + err.message 
        });
    }
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ success: false, message: 'Username and password required' });
        }

        // Fetch user
        const row = db.prepare(
            `SELECT * FROM shareholders WHERE username = ?`
        ).get(username);

        if (!row || !(await bcrypt.compare(password, row.password_hash))) {
            return res.json({ success: false, message: 'Invalid credentials.' });
        }

        // Non-admin accounts must be APPROVED
        if (row.business_role !== 'ADMIN' && row.status !== 'APPROVED') {
            return res.json({ success: false, message: 'Account pending approval. Please wait for admin to approve.' });
        }

        const role = row.business_role === 'ADMIN' ? 'ADMIN' : 'SHAREHOLDER';
        res.json({
            success: true,
            user: { id: row.id, name: row.full_name, role, username: row.username }
        });
    } catch (err) {
        console.error('POST /api/auth/login:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// GET /api/shareholders/:id/dashboard
app.get('/api/shareholders/:id/dashboard', (req, res) => {
    try {
        const sh = db.prepare(`SELECT * FROM shareholders WHERE id = ?`).get(req.params.id);
        if (!sh) return res.status(404).json({ success: false, message: 'Shareholder not found' });

        const subRows = db.prepare(`SELECT business_role, count FROM subscriber_counts`).all();
        const subscriberCounts = {};
        let totalSubscribers = 0;
        subRows.forEach(r => {
            subscriberCounts[r.business_role] = r.count;
            totalSubscribers += r.count;
        });

        const stage = getRunningStage();

        const dividendHistory = db.prepare(`
            SELECT * FROM dividend_history WHERE shareholder_id = ?
            ORDER BY paid_at DESC LIMIT 24
        `).all(sh.id).map(d => ({
            month  : new Date(d.paid_at).toLocaleDateString('en-IN', { year: 'numeric', month: 'long' }),
            amount : d.amount,
            status : d.status
        }));

        const priceRows2 = db.prepare(`SELECT business_role, price FROM role_prices`).all();
        const rolePrices = {};
        priceRows2.forEach(r => { rolePrices[r.business_role] = r.price; });

        res.json({
            success: true,
            id              : sh.id,
            fullName        : sh.full_name,
            fatherName      : sh.father_name,
            address         : sh.address,
            pinCode         : sh.pin_code,
            phone           : sh.phone,
            email           : sh.email,
            businessRole    : sh.business_role,
            numShares       : sh.num_shares,
            totalInvestment : sh.total_investment,
            pricePerShare   : sh.price_per_share,
            investmentStage : sh.stage,
            status          : sh.status,
            createdAt       : sh.created_at,
            totalSubscribers,
            subscriberCounts,
            rolePrices,
            currentStage    : stage,
            dividendHistory
        });
    } catch (err) {
        console.error('GET /api/shareholders/:id/dashboard:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// GET /api/prices
app.get('/api/prices', (req, res) => {
    try {
        const rows = db.prepare(`SELECT business_role, price FROM role_prices`).all();
        const prices = {};
        rows.forEach(r => { prices[r.business_role] = r.price; });
        res.json({ success: true, prices });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// PUT /api/admin/prices
app.put('/api/admin/prices', (req, res) => {
    try {
        const { prices } = req.body;
        if (!prices) return res.status(400).json({ success: false, message: 'prices required' });
        const upd = db.prepare(
            `INSERT INTO role_prices (business_role, price, updated_at)
             VALUES (?, ?, datetime('now'))
             ON CONFLICT(business_role) DO UPDATE SET price = excluded.price, updated_at = excluded.updated_at`
        );
        db.transaction(() => {
            Object.entries(prices).forEach(([role, price]) => upd.run(role, Number(price)));
        })();
        res.json({ success: true, message: 'Prices updated' });
    } catch (err) {
        console.error('PUT /api/admin/prices:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// GET /api/admin/dashboard
app.get('/api/admin/dashboard', (req, res) => {
    try {
        const subRows = db.prepare(`SELECT business_role, count FROM subscriber_counts`).all();
        const subscriberCounts = {};
        subRows.forEach(r => { subscriberCounts[r.business_role] = r.count; });

        const priceRows = db.prepare(`SELECT business_role, price FROM role_prices`).all();
        const rolePrices = {};
        priceRows.forEach(r => { rolePrices[r.business_role] = r.price; });

        const agreements = db.prepare(`
            SELECT id, full_name, father_name, email, phone, address, pin_code,
                   business_role, num_shares, total_investment, price_per_share,
                   stage, status, photo_data, signature_data, created_at, approved_at
            FROM   shareholders
            WHERE  business_role != 'ADMIN'
            ORDER  BY CASE status WHEN 'PENDING' THEN 0 WHEN 'APPROVED' THEN 1 ELSE 2 END,
                      created_at DESC
        `).all();

        console.log(`📊 Admin dashboard: Found ${agreements.length} agreements`);
        
        res.json({ success: true, subscriberCounts, rolePrices, agreements });
    } catch (err) {
        console.error('GET /api/admin/dashboard:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// PUT /api/admin/subscribers
app.put('/api/admin/subscribers', (req, res) => {
    try {
        const { businessRole, count } = req.body;
        db.prepare(
            `UPDATE subscriber_counts SET count = ?, updated_at = datetime('now') WHERE business_role = ?`
        ).run(Number(count), businessRole);
        res.json({ success: true, message: 'Subscriber count updated' });
    } catch (err) {
        console.error('PUT /api/admin/subscribers:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// PUT /api/admin/agreements/:id
app.put('/api/admin/agreements/:id', (req, res) => {
    try {
        const { status } = req.body;
        const approvedAt = status === 'APPROVED' ? new Date().toISOString() : null;
        db.prepare(`UPDATE shareholders SET status = ?, approved_at = ? WHERE id = ?`)
          .run(status, approvedAt, req.params.id);
        
        console.log(`✅ Agreement ${req.params.id} updated to ${status}`);
        res.json({ success: true, message: `Status updated to ${status}` });
    } catch (err) {
        console.error('PUT /api/admin/agreements/:id:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// GET /api/shareholders/:id/details
app.get('/api/shareholders/:id/details', (req, res) => {
    try {
        console.log('Fetching details for shareholder ID:', req.params.id);
        const sh = db.prepare(`
            SELECT id, full_name, father_name, address, pin_code, phone, email, 
                   business_role, num_shares, total_investment, price_per_share,
                   stage, status, username, photo_data, signature_data, created_at, approved_at
            FROM shareholders 
            WHERE id = ?
        `).get(req.params.id);
        
        if (!sh) {
            console.log('Shareholder not found for ID:', req.params.id);
            return res.status(404).json({ success: false, message: 'Shareholder not found' });
        }

        console.log('Found shareholder:', sh.full_name);
        res.json({
            success: true,
            ...sh
        });
    } catch (err) {
        console.error('GET /api/shareholders/:id/details:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// POST /api/admin/agreements/:id/pdf
app.post('/api/admin/agreements/:id/pdf', async (req, res) => {
    try {
        const s = db.prepare(`SELECT * FROM shareholders WHERE id = ?`).get(req.params.id);
        if (!s) return res.status(404).json({ success: false, message: 'Shareholder not found' });

        const doc = new PDFDocument({ margin: 0, size: 'A4', autoFirstPage: true });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=QR-agreement-${String(s.id).padStart(5,'0')}.pdf`);
        doc.pipe(res);

        const M        = 45;               // left/right margin
        const pageW    = doc.page.width;   // 595
        const pageH    = doc.page.height;  // 842
        const CW       = pageW - M * 2;    // content width
        const HEADER_H = 72;
        const FOOTER_H = 22;
        const BODY_TOP = HEADER_H + 8;
        const BODY_BOT = pageH - FOOTER_H - 8;
        let   cy       = BODY_TOP;         // current Y — we control this entirely
        let   pageNum  = 1;

        const now      = new Date();
        const sigDate  = now.toLocaleDateString('en-IN');
        const agreementId = `QR-${String(s.id).padStart(5,'0')}`;

        /* ── helpers ─────────────────────────────────── */
        const drawHeader = () => {
            doc.rect(0, 0, pageW, HEADER_H).fill('#1e1b4b');
            doc.fontSize(20).font('Helvetica-Bold').fillColor('white')
               .text('QUICK RIDE', M, 14, { width: CW, align: 'center' });
            doc.fontSize(10).font('Helvetica').fillColor('#a5b4fc')
               .text('Shareholder Investment Agreement', M, 40, { width: CW, align: 'center' });
            // badge
            const badge = s.status === 'APPROVED' ? '#16a34a' : s.status === 'REJECTED' ? '#dc2626' : '#d97706';
            doc.roundedRect(pageW - M - 70, 24, 70, 18, 3).fill(badge);
            doc.fontSize(8).font('Helvetica-Bold').fillColor('white')
               .text(s.status, pageW - M - 70, 30, { width: 70, align: 'center' });
        };

        const drawFooter = () => {
            doc.rect(0, pageH - FOOTER_H, pageW, FOOTER_H).fill('#f3f4f6');
            doc.fontSize(7).font('Helvetica').fillColor('#6b7280')
               .text(
                   `© ${now.getFullYear()} Quick Ride (Sikkim Division)  •  ${agreementId}  •  Page ${pageNum}`,
                   M, pageH - FOOTER_H + 7, { width: CW, align: 'center' }
               );
        };

        const newPage = () => {
            drawFooter();
            doc.addPage({ margin: 0, size: 'A4' });
            pageNum++;
            drawHeader();
            drawFooter();
            cy = BODY_TOP;
        };

        const ensureSpace = (needed) => {
            if (cy + needed > BODY_BOT) newPage();
        };

        // Section bar — returns new cy
        const section = (title) => {
            ensureSpace(22);
            doc.rect(M, cy, CW, 20).fill('#1e1b4b');
            doc.fontSize(9).font('Helvetica-Bold').fillColor('white')
               .text(title, M + 8, cy + 6, { width: CW - 16, lineBreak: false });
            cy += 24;
        };

        // Two-column field row
        const LW = 145;
        const VX = M + LW + 6;
        const VW = CW - LW - 6;
        let rowIdx = 0;
        const field = (label, value, rowH = 17) => {
            // estimate if value needs wrapping
            const valStr = String(value || '—');
            const extraLines = Math.ceil(valStr.length / 55);
            const actualH = rowH + (extraLines > 1 ? (extraLines - 1) * 11 : 0);
            ensureSpace(actualH);
            if (rowIdx % 2 === 0) doc.rect(M, cy, CW, actualH).fill('#f9fafb');
            doc.fontSize(8).font('Helvetica-Bold').fillColor('#374151')
               .text(label, M + 5, cy + 4, { width: LW, lineBreak: false });
            doc.fontSize(8).font('Helvetica').fillColor('#111827')
               .text(valStr, VX, cy + 4, { width: VW });
            cy += actualH;
            rowIdx++;
        };

        // Term block
        const termBlock = (num, title, body) => {
            const titleH = 16;
            const bodyLines = Math.ceil(body.length / 90) + 1;
            const totalH = titleH + bodyLines * 11 + 10;
            ensureSpace(totalH);
            doc.rect(M, cy, CW, titleH).fill('#e0e7ff');
            doc.fontSize(8).font('Helvetica-Bold').fillColor('#3730a3')
               .text(`${num}. ${title}`, M + 6, cy + 4, { width: CW - 12, lineBreak: false });
            cy += titleH;
            doc.fontSize(7.5).font('Helvetica').fillColor('#374151')
               .text(body, M + 10, cy, { width: CW - 20, align: 'justify', lineGap: 1.5 });
            cy = doc.y + 5;
        };

        /* ── PAGE 1 : draw ───────────────────────────── */
        drawHeader();
        drawFooter();

        // ── Meta row
        doc.roundedRect(M, cy, CW, 26, 3).fill('#f3f4f6');
        doc.fontSize(7.5).font('Helvetica').fillColor('#6b7280')
           .text(`Agreement ID: ${agreementId}`, M + 8, cy + 9, { width: CW / 3, lineBreak: false })
           .text(`Submitted: ${new Date(s.created_at).toLocaleDateString('en-IN')}`, M + CW / 3, cy + 9, { width: CW / 3, align: 'center', lineBreak: false })
           .text(`Stage ${s.stage} | Rs.${(s.price_per_share || 1200).toLocaleString('en-IN')}/share`, M + (CW * 2 / 3), cy + 9, { width: CW / 3, align: 'right', lineBreak: false });
        cy += 32;

        // ── Photo — centred block with white card border
        if (s.photo_data && s.photo_data.startsWith('data:image')) {
            try {
                const buf = Buffer.from(s.photo_data.split(',')[1], 'base64');
                const photoSize = 90;
                const photoX = (pageW - photoSize) / 2;
                doc.roundedRect(photoX - 4, cy - 2, photoSize + 8, photoSize + 8, 4)
                   .lineWidth(1).stroke('#d1d5db');
                doc.image(buf, photoX, cy, { width: photoSize, height: photoSize });
                cy += photoSize + 18;
            } catch (_) { cy += 6; }
        } else {
            cy += 6;
        }

        // ── Section 1: Personal
        section('1. Personal Information');
        rowIdx = 0;
        field('Full Name', s.full_name);
        field('Father / Husband Name', s.father_name || '—');
        field('Residential Address', s.address);
        field('Pin Code', s.pin_code || '—');
        field('Mobile Number', s.phone);
        field('Email Address', s.email);

        // ── Section 2: Investment
        section('2. Investment Details');
        rowIdx = 0;
        field('Number of Shares Purchased', String(s.num_shares));
        field('Price per Share', `Rs. ${(s.price_per_share || 1200).toLocaleString('en-IN')}`);
        field('Total Investment Amount', `Rs. ${s.total_investment.toLocaleString('en-IN')}`);
        field('Investment Stage', `Stage ${s.stage} — ${s.stage === 2 ? 'Current Price' : s.stage === 1 ? 'Base Price' : 'Next Price'}`);
        field('Ownership Percentage', `${((s.num_shares / 1000) * 100).toFixed(3)}% of total 1,000 shares`);
        field('Portal Login Username', s.username);
        if (s.approved_at) field('Approved On', new Date(s.approved_at).toLocaleDateString('en-IN'));

        // ── Section 3: Full Terms & Conditions
        section('3. Terms & Conditions');
        cy += 4;

        termBlock(1, 'Company Governance & Decision Authority',
            'The Company shall be governed by a core management team comprising the CEO, Managing Director (MD), and Chief Operating Officer (COO). They serve as the primary decision-making authority for all matters including operations, finance, expansion, recruitment, partnerships, and overall business strategy. Their decisions are final and binding on all shareholders. Investors acknowledge and accept this governance structure as a condition of their investment.');

        termBlock(2, 'Investor Rights & Limitations',
            'Investors are strictly financial stakeholders and not operational managers of the Company. Investors shall not interfere in the day-to-day operations, staff decisions, or any business function of Quick Ride. Voting rights, if any, shall be exercised strictly as defined in this shareholder agreement and only on matters expressly reserved for shareholder vote. Any attempt to interfere in operations beyond these defined rights shall be deemed a breach of this agreement.');

        termBlock(3, 'Net Profit Definition — The 75% Distribution Threshold',
            'After deduction of the mandatory twenty-five percent (25%) operational and growth reserve from gross monthly earnings, the remaining seventy-five percent (75%) of gross earnings shall be classified as the Net Profit of the Company. Only this Net Profit (i.e., 75% of gross revenue) is eligible for distribution among shareholders. Gross revenue includes all subscription fees, service charges, and platform commissions collected by the Company during the applicable period.');

        termBlock(4, 'Profit Distribution Policy',
            'Net Profit shall be distributed strictly in proportion to each investor\'s shareholding percentage. All shares of the same class carry equal and identical rights to profit distribution. Profit distributions may be made on a quarterly or annual basis, entirely at the discretion of the management team, based on the financial health and growth priorities of the Company. There shall be no guaranteed, fixed, or minimum returns on investment under any circumstances. The Company makes no representation regarding future profits or distributions.');

        termBlock(5, 'Purpose & Use of the 25% Retained Amount',
            'The Company shall retain twenty-five percent (25%) of total gross monthly earnings as a mandatory operational and growth reserve. This retention is essential to ensure long-term sustainability, operational stability, legal compliance, and strategic expansion. This retained amount is not considered profit and is expressly non-distributable. Permitted uses include: (a) App development, upgrades, and security; (b) Cloud hosting, server infrastructure, and technical utilities; (c) Legal advisors, statutory compliance, audits, and financial reviews; (d) Operational staff salaries, regional expansion teams, and performance bonuses; (e) Expansion into new states/regions, onboarding costs, and strategic partnerships.');

        termBlock(6, 'Investment Risks & Acknowledgement',
            'This investment carries significant financial risk. Returns, profits, and dividends are not guaranteed. Dividends depend entirely on business performance, subscriber growth, and market conditions. Share value may fluctuate. This is a long-term investment and early exit may not be possible. Investors may lose part or all of their invested capital. Startup and early-stage investments are inherently high-risk. The Company and its representatives shall not be liable for any financial loss arising from this investment. By signing this agreement, the investor confirms independent due diligence and voluntary participation at their own risk.');

        termBlock(7, 'Transparency & Reporting',
            'The Company shall maintain transparent accounting practices and provide periodic financial summaries to shareholders. Clear reporting of revenue, expenses, and net profit shall be shared; however, full management discretion shall prevail in all operational and strategic decisions. Financial reports shall be made available to shareholders at least once per financial year or upon reasonable written request, subject to confidentiality obligations of the Company.');

        // ── Section 4: Investor Declaration
        section('4. Investor Declaration');
        cy += 4;
        ensureSpace(52);
        doc.fontSize(8).font('Helvetica').fillColor('#374151')
           .text(
               'I, the undersigned, hereby confirm that I have read, understood, and voluntarily agree to all the terms and conditions set forth in this Shareholder Investment Agreement. I confirm that all information provided by me in this application is true, complete, and accurate to the best of my knowledge. I acknowledge that this is a high-risk investment with no guarantee of returns, profits, dividends, or capital protection. I understand that startup and early-stage investments may result in partial or total loss of invested capital. I expressly agree that the Company and its representatives shall not be liable for any financial loss arising from this investment. I have conducted independent due diligence and, where required, consulted qualified financial and legal advisors before making this investment decision. This investment is made freely, voluntarily, and entirely at my own risk.',
               M, cy, { width: CW, align: 'justify', lineGap: 2 }
           );
        cy = doc.y + 8;

        // ── Notice bar
        ensureSpace(22);
        doc.roundedRect(M, cy, CW, 20, 3).fill('#fefce8');
        doc.fontSize(7).font('Helvetica-Bold').fillColor('#92400e')
           .text('IMPORTANT: This document is legally valid only when signed by both parties below.',
               M + 8, cy + 6, { width: CW - 16, lineBreak: false });
        cy += 26;

        // ── Section 5: Signatures — two side-by-side panels
        ensureSpace(110);
        section('5. Manual Signatures');
        cy += 6;

        const sigPanelW = (CW - 16) / 2;
        const sigPanelH = 90;
        const investorX = M;
        const authorityX = M + sigPanelW + 16;

        // Investor panel
        doc.roundedRect(investorX, cy, sigPanelW, sigPanelH, 4).fill('#f0fdf4');
        doc.roundedRect(investorX, cy, sigPanelW, sigPanelH, 4).lineWidth(0.8).stroke('#16a34a');
        doc.fontSize(8).font('Helvetica-Bold').fillColor('#14532d')
           .text('INVESTOR SIGNATURE', investorX + 8, cy + 8, { width: sigPanelW - 16, lineBreak: false });
        doc.fontSize(7.5).font('Helvetica').fillColor('#374151')
           .text(`Name: ${s.full_name}`, investorX + 8, cy + 22, { width: sigPanelW - 16, lineBreak: false })
           .text(`Date: ${sigDate}`, investorX + 8, cy + 34, { width: sigPanelW - 16, lineBreak: false });
        // Signature underline
        doc.moveTo(investorX + 8, cy + 68).lineTo(investorX + sigPanelW - 8, cy + 68).lineWidth(1).stroke('#16a34a');
        if (s.signature_data && !s.signature_data.startsWith('data:image')) {
            // text signature
            doc.fontSize(11).font('Helvetica-Oblique').fillColor('#1a1a2e')
               .text(s.signature_data, investorX + 8, cy + 50, { width: sigPanelW - 16, lineBreak: false });
        } else if (s.signature_data && s.signature_data.startsWith('data:image')) {
            try {
                const sigBuf = Buffer.from(s.signature_data.split(',')[1], 'base64');
                doc.image(sigBuf, investorX + 8, cy + 46, { width: sigPanelW - 16, height: 22 });
            } catch (_) {}
        } else {
            doc.fontSize(7).fillColor('#9ca3af')
               .text('(Investor Signature)', investorX + 8, cy + 56, { width: sigPanelW - 16, align: 'center', lineBreak: false });
        }
        doc.fontSize(7).font('Helvetica').fillColor('#6b7280')
           .text('Signature', investorX + 8, cy + 72, { width: sigPanelW - 16, align: 'center', lineBreak: false });

        // Authority panel
        doc.roundedRect(authorityX, cy, sigPanelW, sigPanelH, 4).fill('#eff6ff');
        doc.roundedRect(authorityX, cy, sigPanelW, sigPanelH, 4).lineWidth(0.8).stroke('#2563eb');
        doc.fontSize(8).font('Helvetica-Bold').fillColor('#1e3a8a')
           .text('AUTHORITY SIGNATURE', authorityX + 8, cy + 8, { width: sigPanelW - 16, lineBreak: false });
        doc.fontSize(7.5).font('Helvetica').fillColor('#374151')
           .text('Quick Ride (Sikkim Division)', authorityX + 8, cy + 22, { width: sigPanelW - 16, lineBreak: false })
           .text(`Date: ${sigDate}`, authorityX + 8, cy + 34, { width: sigPanelW - 16, lineBreak: false });
        doc.moveTo(authorityX + 8, cy + 68).lineTo(authorityX + sigPanelW - 8, cy + 68).lineWidth(1).stroke('#2563eb');
        doc.fontSize(7).font('Helvetica').fillColor('#9ca3af')
           .text('(Authorised Signatory)', authorityX + 8, cy + 56, { width: sigPanelW - 16, align: 'center', lineBreak: false });
        doc.fontSize(7).font('Helvetica').fillColor('#6b7280')
           .text('Signature', authorityX + 8, cy + 72, { width: sigPanelW - 16, align: 'center', lineBreak: false });

        cy += sigPanelH + 10;

        // ── Office address line
        ensureSpace(16);
        doc.fontSize(7).font('Helvetica').fillColor('#6b7280')
           .text('Quick Ride Office: Burtuk, Helipad Gangtok, 737101, East District, Sikkim  |  Phone: +91 9932369890  |  Email: quickcab2026@gmail.com',
               M, cy, { width: CW, align: 'center', lineBreak: false });
        cy += 14;

        // Draw final footer on last page
        drawFooter();
        doc.end();

    } catch (err) {
        console.error('POST /api/admin/agreements/:id/pdf:', err.message);
        if (!res.headersSent) res.status(500).json({ success: false, message: err.message });
    }
});

// ==================== START ====================
app.listen(PORT, () => {
    console.log(`\n${'═'.repeat(52)}`);
    console.log(`🚀  Quick Ride  →  http://localhost:${PORT}`);
    console.log(`📂  DB          →  ${dbPath}`);
    console.log(`${'═'.repeat(52)}`);
    console.log(`🔑  Admin  →  username: admin  |  password: admin123`);
    console.log(`${'═'.repeat(52)}\n`);
});

process.on('SIGINT', () => {
    try { db.close(); } catch (_) {}
    console.log('\n✅  Server stopped. Goodbye!');
    process.exit(0);
});