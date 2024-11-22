const puppeteer = require('puppeteer-core');
const puppeteerExtra = require('puppeteer-extra');

const fs = require('fs');
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

// Function to get the total number of pages
async function getTotalPages(page, url) {
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
            console.log('Second structure for total listings not found either.');
        }
    }

    if (totalListingsText) {
        const totalListings = parseInt(totalListingsText.replace(/\D/g, ''));
        const totalPages = Math.ceil(totalListings / 50);
        console.log(`Total listings found: ${totalListings}, Total pages: ${totalPages}`);
        return totalPages;
    } else {
        console.log('Failed to find total listing information.');
        return 0;
    }
}

// Function to get property URLs from a single page
async function getPropertyUrls(page, url) {
    await page.goto(url, { waitUntil: 'load', timeout: 20000 });

    try {
        await page.waitForSelector('div.relative.min-h-80', { timeout: 60000 });

        const propertyLinks = await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('div.relative.min-h-80 a'));
            return links.map(link => link.href);
        });

        return new Set(propertyLinks);
    } catch (error) {
        console.log('Property URLs not found:', error);
        return new Set();
    }
}

// Function to scrape data from a property page
async function scrapePropertyData(page, url) {
    await page.goto(url, { waitUntil: 'load', timeout: 0 });

    let name = 'N/A';
    try {
        name = await page.$eval('meta[property="og:title"]', el => el.content || 'N/A');
    } catch (error) {
        try {
            name = await page.$eval('title', el => el.textContent.trim());
        } catch (fallbackError) {
            console.log('Title not found:', fallbackError);
        }
    }

    let description = 'N/A';
    try {
        description = await page.$eval('span.text-gray-600.pr-2', el => el.textContent.trim());
    } catch (error) {
        console.log('Description not found:', error);
    }

    let address = 'N/A';
    try {
        const street = await page.$eval('h1 span.text-lg.font-semibold', el => el.textContent.trim());
        const city = await page.$eval('h1 span.text-xs.font-light', el => el.textContent.trim());
        address = `${street}, ${city}`;
    } catch (error) {
        console.log('Address not found:', error);
    }

    let energyRating = 'N/A';
    try {
        energyRating = await page.$eval('div[aria-describedby="tippy-tooltip-1"] svg title', el => el.textContent.trim());
    } catch (error) {
        console.log('Energy rating not found:', error);
    }

    const ldJsonData = await page.$$eval('script[type="application/ld+json"]', scripts => {
        let geo = {};
        let offers = {};
        scripts.forEach(script => {
            const jsonData = JSON.parse(script.textContent);
            if (Array.isArray(jsonData)) {
                jsonData.forEach(item => {
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

    const transactionType = 'N/A';
    const characteristicsArray = [];
    const area = 'N/A';

    return {
        name,
        description,
        address,
        price: propertyPrice,
        area,
        energy_rating: energyRating,
        transaction_type: transactionType,
        latitude: propertyLatitude,
        longitude: propertyLongitude,
        source_url: url
    };
}

// Main function to scrape properties from all pages
async function scrapePropertiesFromUrls(urls) {
    const browser = await puppeteerExtra.launch({
  headless: 'new', // Correctly set headless to 'new'
  args: ['--no-sandbox', '--disable-setuid-sandbox']
});

    const page = await browser.newPage();
    const allData = [];

    for (let baseUrl of urls) {
        const totalPages = await getTotalPages(page, baseUrl);

        let allPropertyUrls = [];
        for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
            const pageUrl = baseUrl.includes('?') ? `${baseUrl}&page=${pageNum}` : `${baseUrl}?page=${pageNum}`;
            let propertyUrls = await getPropertyUrls(page, pageUrl);
            allPropertyUrls = allPropertyUrls.concat([...propertyUrls]);
        }

        for (let propertyUrl of allPropertyUrls) {
            const propertyData = await scrapePropertyData(page, propertyUrl);
            allData.push(propertyData);
        }

        const fileName = `output/${sanitizeFileName(baseUrl)}.xlsx`;
        saveToExcel(allData, fileName);
    }

    await browser.close();
    return allData;
}

// Function to sanitize the filename
function sanitizeFileName(url) {
    return url.replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

// Function to save data to Excel
function saveToExcel(data, filename) {
    const worksheet = xlsx.utils.json_to_sheet(data);
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, 'Properties');
    fs.mkdirSync('output', { recursive: true });
    xlsx.writeFile(workbook, filename);
    console.log(`Data saved to ${filename}`);
}

// Example usage
(async () => {
    const urls = [
        'https://www.boligsiden.dk/tilsalg/husbaad'
    ];

    await scrapePropertiesFromUrls(urls);
})();
