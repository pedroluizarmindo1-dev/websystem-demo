PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS services(id INTEGER PRIMARY KEY,external_id TEXT UNIQUE,source TEXT NOT NULL DEFAULT 'manual',name TEXT NOT NULL,category TEXT NOT NULL,brand TEXT,model TEXT,price_usd REAL NOT NULL DEFAULT 0,available INTEGER NOT NULL DEFAULT 1,eta TEXT,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS exchange_rates(id INTEGER PRIMARY KEY,base TEXT NOT NULL DEFAULT 'USD',quote TEXT NOT NULL DEFAULT 'BRL',rate REAL NOT NULL CHECK(rate>0),provider TEXT NOT NULL,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY,customer_name TEXT NOT NULL,customer_contact TEXT,device_brand TEXT,device_model TEXT NOT NULL,service_id INTEGER REFERENCES services(id),price_brl REAL NOT NULL DEFAULT 0,anydesk_id TEXT,payment_status TEXT NOT NULL DEFAULT 'pendente',status TEXT NOT NULL DEFAULT 'pendente',created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS remote_sessions(id INTEGER PRIMARY KEY,order_id INTEGER NOT NULL REFERENCES orders(id),anydesk_id TEXT NOT NULL,scheduled_at TEXT,status TEXT NOT NULL DEFAULT 'aguardando_conexao',created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS remote_messages(id INTEGER PRIMARY KEY,session_id INTEGER NOT NULL REFERENCES remote_sessions(id),sender TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS audit_logs(id INTEGER PRIMARY KEY,entity TEXT NOT NULL,entity_id INTEGER,action TEXT NOT NULL,detail TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
INSERT OR IGNORE INTO settings(key,value) VALUES ('margin_percent','20'),('spread_brl','0');

CREATE TABLE IF NOT EXISTS reseller_keys(id INTEGER PRIMARY KEY,label TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,allowed_ip TEXT NOT NULL, tier TEXT NOT NULL DEFAULT 'lojista',enabled INTEGER NOT NULL DEFAULT 1,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS wallet_entries(id INTEGER PRIMARY KEY,kind TEXT NOT NULL,amount_brl REAL NOT NULL CHECK(amount_brl>=0),method TEXT,reference TEXT,proof TEXT,status TEXT NOT NULL DEFAULT 'pending',order_id INTEGER,description TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS support_tickets(id INTEGER PRIMARY KEY,order_id INTEGER,subject TEXT NOT NULL,description TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',resolution TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS campaigns(id INTEGER PRIMARY KEY,title TEXT NOT NULL,body TEXT NOT NULL,link TEXT,active INTEGER NOT NULL DEFAULT 1,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
INSERT OR IGNORE INTO settings(key,value) VALUES ('retail_markup_percent','0'),('lojista_discount_percent','5'),('atacado_discount_percent','10');
CREATE INDEX IF NOT EXISTS idx_services_category ON services(category);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
INSERT OR IGNORE INTO campaigns(id,title,body,link) VALUES (1,'Central de serviços GSM','Explore serviços, ferramentas e anúncios atualizados. Consulte disponibilidade antes de solicitar.','https://t.me/PriceNotification');
