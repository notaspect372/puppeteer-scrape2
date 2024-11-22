const puppeteer = require('puppeteer-extra');
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

// Function to accept cookies
async function acceptCookies(page) {
    try {
        await page.waitForSelector('#didomi-notice-agree-button', { timeout: 5000 });
        await page.click('#didomi-notice-agree-button');
        console.log('Cookies accepted');
    } catch (error) {
        console.log('Cookie acceptance button not found:', error);
    }
}

// Function to get total pages
async function getTotalPages(page, url) {
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await acceptCookies(page);

        let totalListingsText;
        try {
            totalListingsText = await page.$eval('h1.flex-1.text-blue-900.text-xl.font-black', el => el.textContent.trim());
        } catch (error) {
            console.log('First structure for total listings not found, trying the second structure.');
        }

        if (!totalListingsText) {
            try {
                totalListingsText = await page.$eval('h1[class*="flex-1"][class*="text-blue-900"][class*="text-xl"][class*="font-black"]', el => el.textContent.trim());
            } catch (error) {
                console.log('Second structure for total listings not found.');
            }
        }

        if (totalListingsText) {
            const totalListings = parseInt(totalListingsText.replace(/\D/g, ''), 10);
            const totalPages = Math.ceil(totalListings / 50);
            console.log(`Total listings found: ${totalListings}, Total pages: ${totalPages}`);
            return totalPages;
        }
    } catch (error) {
        console.log('Error getting total pages:', error);
    }
    return 0;
}

// Function to get property URLs
async function getPropertyUrls(page, url) {
    try {
        await page.goto(url, { waitUntil: 'load', timeout: 20000 });
        await page.waitForSelector('div.relative.min-h-80', { timeout: 60000 });

        const propertyLinks = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('div.relative.min-h-80 a')).map(link => link.href);
        });

        return new Set(propertyLinks);
    } catch (error) {
        console.log(`Error fetching property URLs for ${url}:`, error);
        return new Set();
    }
}

// Function to scrape property data
async function scrapePropertyData(page, url) {
    try {
        await page.goto(url, { waitUntil: 'load', timeout: 30000 });

        const name = await page.$eval('meta[property="og:title"]', el => el.content || 'N/A').catch(() => 'N/A');
        const description = await page.$eval('span.text-gray-600.pr-2', el => el.textContent.trim()).catch(() => 'N/A');
        const address = await page.evaluate(() => {
            const street = document.querySelector('h1 span.text-lg.font-semibold')?.textContent.trim() || 'N/A';
            const city = document.querySelector('h1 span.text-xs.font-light')?.textContent.trim() || 'N/A';
            return `${street}, ${city}`;
        });

        const energyRating = await page.$eval('div[aria-describedby="tippy-tooltip-1"] svg title', el => el.textContent.trim()).catch(() => 'N/A');

        const ldJsonData = await page.$$eval('script[type="application/ld+json"]', scripts => {
            const data = { geo: {}, offers: {} };
            scripts.forEach(script => {
                const jsonData = JSON.parse(script.textContent || '{}');
                if (Array.isArray(jsonData)) {
                    jsonData.forEach(item => {
                        if (item['@type'] === 'SingleFamilyResidence') data.geo = item.geo || {};
                        if (item['@type'] === 'Product') data.offers = item.offers || {};
                    });
                }
            });
            return data;
        });

        const { geo, offers } = ldJsonData;
        const price = offers.price || 'N/A';
        const latitude = geo.latitude || 'N/A';
        const longitude = geo.longitude || 'N/A';

    const propertyTypeKeywords = ['Villa', 'Ejerlejlighed', 'Rækkehus', 'Fritidsbolig', 'Andelsbolig', 'Landejendom', 'Helårsgrund', 'Villalejlighed', 'Fritidsgrund', 'Husbåd'];
    let propertyType = 'N/A';
    for (let keyword of propertyTypeKeywords) {
        if (name.includes(keyword) || description.includes(keyword)) {
            propertyType = keyword;
            break;
        }
    }

    let transactionType = 'N/A';
    try {
        await page.waitForSelector('.text-blue-900.text-sm.font-bold.mb-2', { timeout: 0 });
        transactionType = await page.$eval('.text-blue-900.text-sm.font-bold.mb-2', el => el.textContent.trim());
    } catch (error) {
        console.log('Transaction type element not found or took too long to load:', error);
    }

    const characteristicsArray = await page.$$eval('.py-5.px-2.grid-cols-2 div', nodes => {
        const data = [];
        const seen = new Set();
        nodes.forEach(node => {
            const label = node.querySelector('span')?.textContent.trim() || null;
            if (label) {
                const parts = label.split(':');
                const key = parts[0].trim();
                const value = parts[1] ? parts[1].trim() : 'N/A';
                if (!seen.has(key)) {
                    data.push({ key, value });
                    seen.add(key);
                }
            }
        });
        return data;
    });

    const area = characteristicsArray.find(item => item.key.includes('m²'))?.key || 'N/A';
    const characteristics = characteristicsArray.map(item => `${item.key}: ${item.value}`).join(', ');

return {
    name,
    description,
    address,
    price, // Correct variable name
    property_type: propertyType,
    area,
    energy_rating: energyRating,
    transaction_type: transactionType,
    latitude, // Correct variable name
    longitude, // Correct variable name
    characteristics,
    source_url: url
};
    } catch (error) {
        console.log(`Error scraping property data for ${url}:`, error);
        return { error: `Failed to scrape ${url}` };
    }
}

// Function to save data to Excel
function saveToExcel(data, filename) {
    // Ensure 'output' directory exists
    const outputDir = path.join(__dirname, 'output');
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    // Prepare data for saving
    data.forEach(item => {
        if (typeof item.characteristics === 'object') {
            item.characteristics = JSON.stringify(item.characteristics);
        }
    });

    // Generate Excel file
    const worksheet = xlsx.utils.json_to_sheet(data);
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, 'Properties');

    // Save file in the 'output' directory
    const filePath = path.join(outputDir, filename);
    xlsx.writeFile(workbook, filePath);
    console.log(`Data saved to ${filePath}`);
}

// Main function to scrape properties
async function scrapePropertiesFromUrls(urls) {
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    const allData = [];

    for (const baseUrl of urls) {
        const totalPages = await getTotalPages(page, baseUrl);
        console.log(`Total number of pages for ${baseUrl}: ${totalPages}`);

        for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
            const pageUrl = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}page=${pageNum}`;
            const propertyUrls = await getPropertyUrls(page, pageUrl);

            for (const propertyUrl of propertyUrls) {
                const propertyData = await scrapePropertyData(page, propertyUrl);
                allData.push(propertyData);
            }
        }

        const fileName = `${baseUrl.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.xlsx`;
        saveToExcel(allData, fileName);
    }

    await browser.close();
}

// Example usage
(async () => {
    const urls = ['https://www.boligsiden.dk/tilsalg/husbaad'];
    await scrapePropertiesFromUrls(urls);
})();
