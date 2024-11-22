const puppeteer = require('puppeteer-core');
const fs = require('fs');
const xlsx = require('xlsx');
const { time } = require('console');
const puppeteerExtra = require('puppeteer-extra');

// Function to get the total number of pages
// Function to get the total number of pages


async function acceptCookies(page) {
    try {
        await page.waitForSelector('#didomi-notice-agree-button', { timeout: 5000 });
        await page.click('#didomi-notice-agree-button');
        console.log('Cookies accepted');
    } catch (error) {
        console.log('Cookie acceptance button not found:', error);
    }
}

async function getTotalPages(page, url) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    // Try the first structure
    await acceptCookies(page); // Accept cookies after page load

    let totalListingsText;
    try {
        totalListingsText = await page.$eval('h1.flex-1.text-blue-900.text-xl.font-black', el => el.textContent.trim());
    } catch (error) {
        console.log('First structure for total listings not found, trying the second structure.');
    }

    // If the first structure is not found, try the second structure
    if (!totalListingsText) {
        try {
            totalListingsText = await page.$eval('h1[class*="flex-1"][class*="text-blue-900"][class*="text-xl"][class*="font-black"]', el => el.textContent.trim());
        } catch (error) {
            console.log('Second structure for total listings not found either.');
        }
    }

    // If totalListingsText is found, calculate total pages
    if (totalListingsText) {
        // Remove non-numeric characters like period (thousands separator) and convert to an integer
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
    console.log("url:", url);
    await page.goto(url, { waitUntil: 'load', timeout: 20000 });

    try {
        // Wait for the main container that contains the property links
        await page.waitForSelector('div.relative.min-h-80', { timeout: 60000 });

        const propertyLinks = await page.evaluate(() => {
            // Select all anchor tags within the specific container
            const links = Array.from(document.querySelectorAll('div.relative.min-h-80 a'));
            // Map to the href attribute to get the URLs
            return links.map(link => link.href);
        });

        // Convert the array of links to a Set
        return new Set(propertyLinks);
    } catch (error) {
        console.log('Property URLs not found:', error);
        return new Set(); // Return an empty Set in case of an error
    }
}

// Function to scrape data from a property page
async function scrapePropertyData(page, url) {
    await page.goto(url, { waitUntil: 'load', timeout: 0 });

    let name = 'N/A';
    try {
        // Try the first selector
        name = await page.$eval('meta[property="og:title"]', el => el.content || 'N/A');
    } catch (error) {
        console.log('Meta tag for title not found. Trying <title> tag as fallback.');

        // Fallback to the <title> tag
        try {
            name = await page.$eval('title', el => el.textContent.trim());
        } catch (fallbackError) {
            console.log('Fallback method for title also failed:', fallbackError);
        }
    }    let description = 'N/A';
    try {
        description = await page.$eval('span.text-gray-600.pr-2', el => el.textContent.trim());
    } catch (error) {
        console.log('Description not found:', error);
    }
    // Address 
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

    const price = 'N/A';
    const latitude = 'N/A';
    const longitude = 'N/A';

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
        price: propertyPrice,
        property_type: propertyType,
        area,
        energy_rating: energyRating,
        transaction_type: transactionType,
        latitude: propertyLatitude,
        longitude: propertyLongitude,
        characteristics,
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
        console.log(`Total number of pages for ${baseUrl}: ${totalPages}`);

        let allPropertyUrls = [];
        for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
            // Check if the base URL contains an existing query parameter (i.e., '?')
            let pageUrl;
            if (baseUrl.includes('?')) {
                // If it does, use '&page=' to append the page number
                pageUrl = `${baseUrl}&page=${pageNum}`;
            } else {
                // If not, use '?page=' to start the query parameter
                pageUrl = `${baseUrl}?page=${pageNum}`;
            }

            let propertyUrls = await getPropertyUrls(page, pageUrl);
            console.log(propertyUrls);

            allPropertyUrls = allPropertyUrls.concat(propertyUrls);
        }

        console.log(`Total number of property URLs for ${baseUrl}: ${allPropertyUrls.length}`);

        for (let propertyUrl of allPropertyUrls) {
            const propertyData = await scrapePropertyData(page, propertyUrl);
            console.log(propertyData);
            allData.push(propertyData);
        }

        // Save data to an Excel file with base URL in the filename
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
// Function to save data to Excel
function saveToExcel(data, fileName) {
    // Prepare data for Excel, with characteristics and propertyDetails as JSON strings
    const excelData = data.map(item => ({
        ...item,
        characteristics: JSON.stringify(item.characteristics), // Store characteristics as JSON string
        propertyDetails: JSON.stringify(item.propertyDetails), // Store propertyDetails as JSON string
        amenities: item.amenities.join(', ') || 'N/A' // Convert amenities array to a comma-separated string
    }));

    // Ensure the output directory exists
    const outputDir = path.resolve(__dirname, 'output'); // Ensure compatibility with the workflow
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir); // Create directory if it doesn't exist
    }

    // Save the Excel file in the output directory
    const filePath = path.join(outputDir, fileName);
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(excelData);
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Properties');
    XLSX.writeFile(workbook, filePath);
    console.log(`Data saved to ${filePath}`);
}


// Example usage
(async () => {
    const urls = [
        'https://www.boligsiden.dk/tilsalg/husbaad'
    ];

    await scrapePropertiesFromUrls(urls);
})();
