const http = require('http');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

// Ana klasör
const logsDir = path.join(__dirname, 'request-logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

// SQLite veritabanı oluştur
const dbPath = path.join(__dirname, 'requests.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('❌ Veritabanı bağlantı hatası:', err);
    } else {
        console.log('✓ Veritabanı bağlantısı kuruldu');
    }
});

// Veritabanı tablosunu oluştur
db.serialize(() => {
    // Ana requests tablosu
    db.run(`CREATE TABLE IF NOT EXISTS requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        method TEXT NOT NULL,
        url TEXT NOT NULL,
        headers TEXT,
        body TEXT,
        body_parsed TEXT,
        query TEXT,
        ip TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Address tablosu (mesaj içindeki adresler için)
    db.run(`CREATE TABLE IF NOT EXISTS addresses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id INTEGER NOT NULL,
        address TEXT NOT NULL,
        type TEXT,
        name TEXT,
        value TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (request_id) REFERENCES requests(id)
    )`);
    
    db.run(`CREATE INDEX IF NOT EXISTS idx_timestamp ON requests(timestamp)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_method ON requests(method)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_address ON addresses(address)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_request_id ON addresses(request_id)`);
});

// Tarih ve saat formatı
function getFormattedDateTime() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const milliseconds = String(now.getMilliseconds()).padStart(3, '0');
    
    return {
        dateFolder: `${year}-${month}-${day}`,
        fileName: `${year}-${month}-${day}_${hours}-${minutes}-${seconds}-${milliseconds}.json`
    };
}

// Request'i JSON dosyasına kaydet
function saveRequestToFile(requestData) {
    const { dateFolder, fileName } = getFormattedDateTime();
    const dayFolder = path.join(logsDir, dateFolder);
    
    // Günlük klasör oluştur
    if (!fs.existsSync(dayFolder)) {
        fs.mkdirSync(dayFolder, { recursive: true });
    }
    
    const filePath = path.join(dayFolder, fileName);
    
    // JSON dosyasını kaydet
    fs.writeFileSync(filePath, JSON.stringify(requestData, null, 2), 'utf8');
    console.log(`✓ İstek kaydedildi: ${dateFolder}/${fileName}`);
}

// Request'i veritabanına kaydet
function saveRequestToDatabase(requestData) {
    return new Promise((resolve, reject) => {
        const stmt = db.prepare(`
            INSERT INTO requests (timestamp, method, url, headers, body, body_parsed, query, ip)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        
        stmt.run(
            requestData.timestamp,
            requestData.method,
            requestData.url,
            JSON.stringify(requestData.headers),
            requestData.body,
            requestData.bodyParsed ? JSON.stringify(requestData.bodyParsed) : null,
            requestData.query,
            requestData.ip,
            function(err) {
                if (err) {
                    console.error('❌ Veritabanı kayıt hatası:', err);
                    reject(err);
                } else {
                    const requestId = this.lastID;
                    console.log(`✓ Veritabanına kaydedildi (ID: ${requestId})`);
                    
                    // Eğer bodyParsed içinde mesaj varsa, adresleri ayrı tabloya kaydet
                    if (requestData.bodyParsed && requestData.bodyParsed.mesaj && Array.isArray(requestData.bodyParsed.mesaj)) {
                        saveAddresses(requestId, requestData.bodyParsed.mesaj)
                            .then(() => resolve(requestId))
                            .catch(reject);
                    } else {
                        resolve(requestId);
                    }
                }
            }
        );
        
        stmt.finalize();
    });
}

// Adresleri ayrı tabloya kaydet
function saveAddresses(requestId, mesajArray) {
    return new Promise((resolve, reject) => {
        const stmt = db.prepare(`
            INSERT INTO addresses (request_id, address, type, name, value)
            VALUES (?, ?, ?, ?, ?)
        `);
        
        let completed = 0;
        let hasError = false;
        
        if (mesajArray.length === 0) {
            resolve();
            return;
        }
        
        mesajArray.forEach(item => {
            stmt.run(
                requestId,
                item.address || null,
                item.type || null,
                item.name || null,
                item.value || null,
                (err) => {
                    if (err && !hasError) {
                        hasError = true;
                        reject(err);
                        return;
                    }
                    
                    completed++;
                    if (completed === mesajArray.length) {
                        console.log(`✓ ${mesajArray.length} adres kaydedildi`);
                        stmt.finalize();
                        resolve();
                    }
                }
            );
        });
    });
}

// HTTP sunucusu oluştur
const server = http.createServer((req, res) => {
    let body = '';
    
    // Request body'yi topla
    req.on('data', chunk => {
        body += chunk.toString();
    });
    
    req.on('end', async () => {
        // Request verilerini hazırla
        const requestData = {
            timestamp: new Date().toISOString(),
            method: req.method,
            url: req.url,
            headers: req.headers,
            body: body,
            query: req.url.includes('?') ? req.url.split('?')[1] : null,
            ip: req.socket.remoteAddress
        };
        
        // Body JSON ise parse et
        if (body && req.headers['content-type']?.includes('application/json')) {
            try {
                requestData.bodyParsed = JSON.parse(body);
            } catch (e) {
                requestData.bodyParseError = 'Invalid JSON';
            }
        }
        
        // Dosyaya ve veritabanına kaydet
        try {
            saveRequestToFile(requestData);
            await saveRequestToDatabase(requestData);
            
            // Başarılı yanıt
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: 'İstek başarıyla kaydedildi',
                timestamp: requestData.timestamp
            }));
        } catch (error) {
            console.error('Kayıt hatası:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                message: 'Kayıt sırasında hata oluştu',
                error: error.message
            }));
        }
    });
});

// Sunucuyu başlat
const PORT = 3000;
server.listen(PORT, () => {
    console.log(`\n🚀 HTTP Sunucusu başlatıldı!`);
    console.log(`📡 Adres: http://localhost:${PORT}`);
    console.log(`📁 Loglar: ${logsDir}`);
    console.log(`💾 Veritabanı: ${dbPath}`);
    console.log(`\nTest etmek için:`);
    console.log(`curl -X POST http://localhost:${PORT}/test -H "Content-Type: application/json" -d "{\\"test\\":\\"data\\"}"\n`);
});

// Hata yakalama
server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
        console.error(`❌ Port ${PORT} kullanımda!`);
    } else {
        console.error('❌ Sunucu hatası:', error);
    }
    process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Sunucu kapatılıyor...');
    db.close((err) => {
        if (err) {
            console.error('Veritabanı kapatma hatası:', err);
        } else {
            console.log('✓ Veritabanı bağlantısı kapatıldı');
        }
        process.exit(0);
    });
});
