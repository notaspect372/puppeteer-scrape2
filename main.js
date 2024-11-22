const puppeteer = require('puppeteer-core');
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
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await acceptCookies(page);

        let totalListingsText;
        try {
            totalListingsText = await page.$eval(
                'h1.flex-1.text-blue-900.text-xl.font-black',
                (el) => el.textContent.trim()
            );
        } catch (error) {
            console.log('First structure for total listings not found, trying the second structure.');
        }

        if (!totalListingsText) {
            try {
                totalListingsText = await page.$eval(
                    'h1[class*="flex-1"][class*="text-blue-900"][class*="text-xl"][class*="font-black"]',
                    (el) => el.textContent.trim()
                );
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
    } catch (error) {
        console.log('Error fetching total pages:', error);
        return 0;
    }
}

// Function to get property URLs from a single page
async function getPropertyUrls(page, url) {
    console.log("Fetching property URLs from:", url);

    // Validate URL before navigating
    try {
        new URL(url); // Throws if the URL is invalid
    } catch (error) {
        console.error("Invalid URL:", url, error);
        return new Set();
    }

    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

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
async function scrapePropertyData(page, url) {
    try {
        await page.goto(url, { waitUntil: 'load', timeout: 0 });

        let name = 'N/A';
        try {
            name = await page.$eval('meta[property="og:title"]', (el) => el.content || 'N/A');
        } catch (error) {
            console.log('Meta tag for title not found. Trying <title> tag as fallback.');
            try {
                name = await page.$eval('title', (el) => el.textContent.trim());
            } catch (fallbackError) {
                console.log('Fallback method for title also failed:', fallbackError);
            }
        }

        let description = 'N/A';
        try {
            description = await page.$eval('span.text-gray-600.pr-2', (el) => el.textContent.trim());
        } catch (error) {
            console.log('Description not found:', error);
        }

        let address = 'N/A';
        try {
            const street = await page.$eval('h1 span.text-lg.font-semibold', (el) =>
                el.textContent.trim()
            );
            const city = await page.$eval('h1 span.text-xs.font-light', (el) =>
                el.textContent.trim()
            );
            address = `${street}, ${city}`;
        } catch (error) {
            console.log('Address not found:', error);
        }

        let energyRating = 'N/A';
        try {
            energyRating = await page.$eval('div[data-tooltipped] svg title', (el) =>
                el.textContent.trim()
            );
        } catch (error) {
            console.log('Energy rating not found:', error);
        }

        const price = 'N/A';
        const latitude = 'N/A';
        const longitude = 'N/A';

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

// Main function to scrape properties from all pages
async function scrapePropertiesFromUrls(urls) {
    const browser = await puppeteerExtra.launch({
        headless: 'new', // Correctly set headless to 'new'
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
      

    const page = await browser.newPage();
    const allData = [];

    for (let baseUrl of urls) {
        try {
            new URL(baseUrl);
        } catch (error) {
            console.error("Invalid base URL:", baseUrl, error);
            continue;
        }

        const totalPages = await getTotalPages(page, baseUrl);
        console.log(`Total number of pages for ${baseUrl}: ${totalPages}`);

        let allPropertyUrls = [];
        for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
            const pageUrl = baseUrl.includes('?')
                ? `${baseUrl}&page=${pageNum}`
                : `${baseUrl}?page=${pageNum}`;

            try {
                new URL(pageUrl);
            } catch (error) {
                console.error("Invalid page URL:", pageUrl, error);
                continue;
            }

            const propertyUrls = await getPropertyUrls(page, pageUrl);
            console.log(`Found ${propertyUrls.size} property URLs on page ${pageNum}`);
            allPropertyUrls = allPropertyUrls.concat([...propertyUrls]);
        }

        console.log(`Total number of property URLs for ${baseUrl}: ${allPropertyUrls.length}`);

        for (let propertyUrl of allPropertyUrls) {
            try {
                new URL(propertyUrl);
            } catch (error) {
                console.error("Invalid property URL:", propertyUrl, error);
                continue;
            }

            const propertyData = await scrapePropertyData(page, propertyUrl);
            console.log(propertyData);
            allData.push(propertyData);
        }

        const fileName = sanitizeFileName(baseUrl) + '.xlsx';
        saveToExcel(allData, fileName);
    }

    await browser.close();
    return allData;
}

// Function to sanitize the filename from the URL
function sanitizeFileName(url) {
    return url.replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

// Function to save scraped data to an Excel file
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
    const urls = ['https://www.boligsiden.dk/tilsalg/husbaad'];
    await scrapePropertiesFromUrls(urls);
})();
