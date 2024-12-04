const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const xlsx = require('xlsx');

// Enable stealth mode
puppeteer.use(StealthPlugin());

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

// Function to get property URLs from a single page
async function getPropertyUrls(page, url) {
    console.log(`Fetching property URLs from: ${url}`);
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 0 });
        await page.waitForSelector('div.relative.min-h-80', { timeout: 60000 });

        const propertyLinks = await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('div.relative.min-h-80 a'));
            return links.map((link) => link.href);
        });

        return new Set(propertyLinks);
    } catch (error) {
        console.error('Error fetching property URLs:', error);
        return new Set();
    }
}

// Function to scrape data from a property page
async function scrapePropertyData(browser, url) {
    try {
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: 'load', timeout: 0 });

        let name = 'N/A';
        try {
            name = await page.$eval('meta[property="og:title"]', (el) => el.content || 'N/A');
        } catch {
            try {
                name = await page.$eval('title', (el) => el.textContent.trim());
            } catch {
                console.log('Name not found.');
            }
        }

        let description = 'N/A';
        try {
            description = await page.$eval('span.text-gray-600.pr-2', (el) => el.textContent.trim());
        } catch {
            console.log('Description not found.');
        }

        let address = 'N/A';
        try {
            const street = await page.$eval('h1 span.text-lg.font-semibold', (el) => el.textContent.trim());
            const city = await page.$eval('h1 span.text-xs.font-light', (el) => el.textContent.trim());
            address = `${street}, ${city}`;
        } catch (error) {
            console.log('Address not found:', error);
        }

        let energyRating = 'N/A';
        try {
            energyRating = await page.$eval('div[data-tooltipped] svg title', (el) => el.textContent.trim());
        } catch (error) {
            console.log('Energy rating not found:', error);
        }

        const ldJsonData = await page.$$eval('script[type="application/ld+json"]', (scripts) => {
            let geo = {};
            let offers = {};
            scripts.forEach((script) => {
                const jsonData = JSON.parse(script.textContent);
                if (Array.isArray(jsonData)) {
                    jsonData.forEach((item) => {
                        if (item['@type'] === 'SingleFamilyResidence') {
                            geo = item.geo || {};
                        } else if (item['@type'] === 'Product') {
                            offers = item.offers || {};
                        }
                    });
                }
            });
            return { geo, offers };
        });

        const { geo, offers } = ldJsonData;
        const propertyPrice = offers.price || 'N/A';
        const propertyLatitude = geo.latitude || 'N/A';
        const propertyLongitude = geo.longitude || 'N/A';

        await page.close();

        return {
            name,
            description,
            address,
            price: propertyPrice,
            energy_rating: energyRating,
            latitude: propertyLatitude,
            longitude: propertyLongitude,
            source_url: url,
        };
    } catch (error) {
        console.error('Error scraping property data:', error);
        return {};
    }
}

// Function to scrape properties within the specified page range
async function scrapePropertiesFromUrls(baseUrls, startPage, endPage) {
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const allData = [];
    const threads = 10;

    for (const baseUrl of baseUrls) {
        const page = await browser.newPage();

        let allPropertyUrls = [];
        for (let pageNum = startPage; pageNum <= endPage; pageNum++) {
            const pageUrl = baseUrl.includes('?') ? `${baseUrl}&page=${pageNum}` : `${baseUrl}?page=${pageNum}`;
            const propertyUrls = await getPropertyUrls(page, pageUrl);
            allPropertyUrls = allPropertyUrls.concat([...propertyUrls]);
        }

        const chunks = [];
        for (let i = 0; i < allPropertyUrls.length; i += threads) {
            chunks.push(allPropertyUrls.slice(i, i + threads));
        }

        for (const chunk of chunks) {
            const results = await Promise.all(chunk.map((url) => scrapePropertyData(browser, url)));
            allData.push(...results);
        }

        await page.close();
    }

    await browser.close();

    const fileName = `properties_${Date.now()}.xlsx`;
    saveToExcel(allData, fileName);
    console.log(`Scraping completed. Data saved to ${fileName}`);
    return allData;
}

// Function to save scraped data to an Excel file
function saveToExcel(data, filename) {
    const worksheet = xlsx.utils.json_to_sheet(data);
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, 'Properties');
    const outputPath = `output/${filename}`;
    fs.mkdirSync('output', { recursive: true });
    xlsx.writeFile(workbook, outputPath);
    console.log(`Data saved to ${outputPath}`);
}

// Example usage
(async () => {
    const urls = ['https://www.boligsiden.dk/tilsalg/ejerlejlighed'];
    const startPage = 1; // Set your desired start page
    const endPage = 3;   // Set your desired end page
    await scrapePropertiesFromUrls(urls, startPage, endPage);
})();
