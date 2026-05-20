const https = require('https');
const fs = require('fs');
const path = require('path');

const libsDir = path.join(__dirname, 'libs');

// Cria a pasta "libs" se ela não existir
if (!fs.existsSync(libsDir)) {
    fs.mkdirSync(libsDir);
}

// Função inteligente que baixa o arquivo e segue redirecionamentos HTTP
function downloadFile(url, dest) {
    https.get(url, (res) => {
        // Lida com redirecionamentos (muito comum em CDNs como unpkg)
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            let redirectUrl = res.headers.location;
            if (!redirectUrl.startsWith('http')) {
                const urlObj = new URL(url);
                redirectUrl = urlObj.origin + redirectUrl;
            }
            return downloadFile(redirectUrl, dest);
        }
        
        if (res.statusCode !== 200) {
            console.error(`Erro ao baixar ${url}: Status ${res.statusCode}`);
            return;
        }

        const file = fs.createWriteStream(dest);
        res.pipe(file);
        
        file.on('finish', () => {
            file.close();
            console.log(`✅ Salvo: ${path.basename(dest)}`);
        });
    }).on('error', (err) => {
        console.error(`❌ Falha em ${url}: ${err.message}`);
    });
}

const filesToDownload = [
    { url: 'https://unpkg.com/react@18/umd/react.production.min.js', name: 'react.production.min.js' },
    { url: 'https://unpkg.com/react-dom@18/umd/react-dom.production.min.js', name: 'react-dom.production.min.js' },
    { url: 'https://unpkg.com/@babel/standalone/babel.min.js', name: 'babel.min.js' },
    { url: 'https://cdn.tailwindcss.com', name: 'tailwindcss.js' },
    { url: 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js', name: 'html2canvas.min.js' }
];

console.log("Iniciando o download das bibliotecas offline para a pasta '/libs'...");

filesToDownload.forEach(file => {
    downloadFile(file.url, path.join(libsDir, file.name));
});