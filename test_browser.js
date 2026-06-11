import puppeteer from 'puppeteer';
import http from 'http';
import fs from 'fs';
import path from 'path';

const server = http.createServer((req, res) => {
    const cleanUrl = req.url.split('?')[0];
    let filePath = '.' + cleanUrl;
    if (filePath === './') {
        filePath = './index.html';
    }

    // Wyciągnij typ MIME
    const extname = path.extname(filePath);
    let contentType = 'text/html';
    switch (extname) {
        case '.js':
            contentType = 'text/javascript';
            break;
        case '.css':
            contentType = 'text/css';
            break;
        case '.png':
            contentType = 'image/png';
            break;
    }

    fs.readFile(filePath, (error, content) => {
        if (error) {
            if (error.code === 'ENOENT') {
                res.writeHead(404);
                res.end('File not found');
            } else {
                res.writeHead(500);
                res.end('Server error: ' + error.code);
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
});

const PORT = 8085;
server.listen(PORT, async () => {
    console.log(`Serwer testowy działa na http://localhost:${PORT}`);

    let browser;
    try {
        // 2. Uruchom Puppeteer
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        const page = await browser.newPage();

        // Przechwytuj logi z konsoli przeglądarki
        page.on('console', msg => {
            console.log(`[BROWSER CONSOLE] ${msg.type().toUpperCase()}: ${msg.text()}`);
        });

        // Przechwytuj błędy JS
        page.on('pageerror', err => {
            console.error(`[BROWSER JS ERROR]: ${err.toString()}`);
        });

        console.log("Ładowanie strony...");
        await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'networkidle0' });
        console.log("Strona załadowana.");

        // Sprawdź czy elementy zostały usunięte
        console.log("Weryfikacja braku usuniętych elementów w DOM...");
        const domVerification = await page.evaluate(() => {
            return {
                chkExportPng: document.getElementById('chk-export-png'),
                chkExportSvg: document.getElementById('chk-export-svg'),
                chkExportStl: document.getElementById('chk-export-stl'),
                frameJointType: document.getElementById('frame-joint-type'),
                frameEnable: document.getElementById('frame-enable')?.checked
            };
        });
        console.log("Status usuniętych elementów (powinny być null):", domVerification);

        if (domVerification.chkExportPng || domVerification.chkExportSvg || domVerification.chkExportStl || domVerification.frameJointType) {
            throw new Error("Błąd: Usunięte elementy wciąż istnieją w DOM!");
        }

        // Mock saveAs to inspect the generated ZIP file
        console.log("Mockowanie saveAs...");
        await page.evaluate(() => {
            window.lastDownloadedBlob = null;
            window.lastDownloadedFilename = null;
            window.saveAs = (blob, filename) => {
                window.lastDownloadedBlob = blob;
                window.lastDownloadedFilename = filename;
            };
        });

        // Klikamy przycisk "Ramka PNG"
        console.log("Klikanie przycisku 'Ramka PNG'...");
        await page.evaluate(() => {
            const btn = document.getElementById('btn-export-frame-png');
            if (btn) btn.click();
            else console.error("Nie znaleziono przycisku 'btn-export-frame-png'!");
        });

        // Czekamy na zakończenie generowania i zapis PNG
        console.log("Oczekiwanie na przechwycenie pobierania PNG...");
        const resultPng = await page.evaluate(async () => {
            for (let i = 0; i < 100; i++) {
                if (window.lastDownloadedBlob) {
                    break;
                }
                await new Promise(r => setTimeout(r, 100));
            }
            if (!window.lastDownloadedBlob) {
                throw new Error("Timeout: nie przechwycono pobierania PNG!");
            }
            return {
                filename: window.lastDownloadedFilename,
                type: window.lastDownloadedBlob.type
            };
        });
        console.log("Nazwa pobranego pliku PNG:", resultPng.filename);

        if (!resultPng.filename.endsWith('.png')) {
            throw new Error(`Błąd: Nazwa pliku nie kończy się na .png: ${resultPng.filename}`);
        }
        console.log("Sukces: Pomyślnie pobrano plik ramki w formacie PNG!");

        // Resetowanie przechwytywania
        await page.evaluate(() => {
            window.lastDownloadedBlob = null;
            window.lastDownloadedFilename = null;
        });

        // Klikamy przycisk "Ramka SVG"
        console.log("Klikanie przycisku 'Ramka SVG'...");
        await page.evaluate(() => {
            const btn = document.getElementById('btn-export-frame-svg');
            if (btn) btn.click();
            else console.error("Nie znaleziono przycisku 'btn-export-frame-svg'!");
        });

        // Czekamy na zakończenie generowania i zapis SVG
        console.log("Oczekiwanie na przechwycenie pobierania SVG...");
        const resultSvg = await page.evaluate(async () => {
            for (let i = 0; i < 100; i++) {
                if (window.lastDownloadedBlob) {
                    break;
                }
                await new Promise(r => setTimeout(r, 100));
            }
            if (!window.lastDownloadedBlob) {
                throw new Error("Timeout: nie przechwycono pobierania SVG!");
            }
            return {
                filename: window.lastDownloadedFilename,
                type: window.lastDownloadedBlob.type
            };
        });
        console.log("Nazwa pobranego pliku SVG:", resultSvg.filename);

        if (!resultSvg.filename.endsWith('.svg')) {
            throw new Error(`Błąd: Nazwa pliku nie kończy się na .svg: ${resultSvg.filename}`);
        }
        console.log("Sukces: Pomyślnie pobrano plik ramki w formacie SVG!");

    } catch (err) {
        console.error("Błąd podczas testu:", err);
    } finally {
        if (browser) {
            await browser.close();
        }
        server.close();
        process.exit(0);
    }
});
