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

// Function to get the total number of pages
async function getTotalPages(page, url) {
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 0 });
        await acceptCookies(page);

        let totalListingsText;
        try {
            totalListingsText = await page.$eval(
                'h1.flex-1.text-blue-900.text-xl.font-black',
                (el) => el.textContent.trim()
            );
        } catch {
            console.log('First structure for total listings not found, trying alternative.');
        }

        if (!totalListingsText) {
            try {
                totalListingsText = await page.$eval(
                    'h1[class*="flex-1"][class*="text-blue-900"][class*="text-xl"][class*="font-black"]',
                    (el) => el.textContent.trim()
                );
            } catch {
                console.log('Failed to retrieve total listings information.');
                return 0;
            }
        }

        const totalListings = parseInt(totalListingsText.replace(/\D/g, ''), 10);
        const totalPages = Math.ceil(totalListings / 50);
        console.log(`Total listings found: ${totalListings}, Total pages: ${totalPages}`);
        return totalPages;
    } catch (error) {
        console.log('Error fetching total pages:', error);
        return 0;
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

        const characteristicsArray = await page.$$eval('.py-5.px-2.grid-cols-2 div', (nodes) => {
            const data = [];
            nodes.forEach((node) => {
                const label = node.querySelector('span')?.textContent.trim() || null;
                if (label) {
                    const parts = label.split(':');
                    const key = parts[0]?.trim() || 'Unknown';
                    const value = parts[1]?.trim() || 'N/A';
                    data.push({ key, value });
                }
            });
            return data;
        });
        
        // Filter out duplicate key-value pairs
        const uniqueCharacteristics = Array.from(
            new Map(characteristicsArray.map((item) => [item.key, item])).values()
        );
        
        // Extract the area specifically related to 'm²'
        const area = uniqueCharacteristics
            .find((item) => item.key.toLowerCase().includes('m²'))?.key || 'N/A';
        
        // Create a properly formatted string of characteristics
        const characteristics = uniqueCharacteristics
            .map((item) => `${item.key}: ${item.value}`)
            .join(', ');

        await page.close();

        return {
            name,
            description,
            address,
            price: propertyPrice,
            area,
            energy_rating: energyRating,
            latitude: propertyLatitude,
            longitude: propertyLongitude,
            characteristics,
            source_url: url,
        };
    } catch (error) {
        console.error('Error scraping property data:', error);
        return {};
    }
}

// Function to scrape properties with 10 threads
async function scrapePropertiesFromUrls(urls) {
 const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    protocolTimeout: 120000, // Increase timeout to 2 minutes
});

    const allData = [];
    const threads = 10;

    for (const baseUrl of urls) {
        const page = await browser.newPage();
        const totalPages = await getTotalPages(page, baseUrl);
        console.log(`Total pages for ${baseUrl}: ${totalPages}`);

        let allPropertyUrls = [];
        for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
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
            console.log(results)
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
    const urls = ['https://www.boligsiden.dk/tilsalg/villa?priceMin=5400000'];
    await scrapePropertiesFromUrls(urls);
})();
