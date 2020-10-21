const AWS = require('aws-sdk'); 
const dynamoDb = new AWS.DynamoDB.DocumentClient();

const brandSettings = require('brand_settings.json')

async function loadStoreCountFromDB(brand) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "id, sk, country",
        KeyConditionExpression: "#id = :value",
        ExpressionAttributeNames:{
            "#id": "id"
        },
        ExpressionAttributeValues: {
            ":value": `${brand}#store`
        },
    };

    return dynamoDb.query(params).promise().then(data => {
        if (!data.Items || data.Items.length < 1) return 0
        return data.Items.reduce((acc, item) => {
            if (!item.country) return acc
            if (item.sk && item.sk.startsWith(brand)) return acc
            const oldCount = acc[item.country]
            acc[item.country] = oldCount !== undefined ? oldCount + 1 : 1
            return acc
        }, {})
    })
}

const saveMonthlyReceiptInDB = async (brand, cost, parameters) => {
    const fullTimeString = (new Date()).toISOString()
    const timeString = fullTimeString.substring(0, 7);
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        Item: {
            "id": `receipt#${brand}`,
            "sk": timeString,
            "sk2": `monthlyCost#${fullTimeString}`,
            "cost": cost,
            "parameters": parameters ? JSON.stringify(parameters) : "{}"
        }
    };

    return dynamoDb.put(params).promise();
}

// Count all brands stores used this month and create a receipt for the used stors
exports.monthlyStores = async (event, context, callback) => {

    try {
        const brands = Object.keys(brandSettings)

        let promises = brands
            .filter(brand => brandSettings[brand].MonthlyCostSettings !== undefined)
            .map(brand => {
                const settings = brandSettings[brand].MonthlyCostSettings
                const storeCountPromise = loadStoreCountFromDB(brand)
                return storeCountPromise.then( storeCounts => {
                    console.log(`freeCountries: `, settings.freeCountries)
                    const totalNonFreeCountryStores = Object.keys(storeCounts).reduce((acc, countryCode) => {
                        if (settings.freeCountries.includes(countryCode)) return acc
                        console.log(`Adding costs for ${storeCounts[countryCode]} stores from ${countryCode}`)
                        const count = storeCounts[countryCode]
                        return acc + count
                    }, 0)
                    const cost = settings.costPerStore * totalNonFreeCountryStores
                    console.log(`Brand '${brand}', cost: ${cost}, stores: `, storeCounts)

                    return saveMonthlyReceiptInDB(brand, cost, storeCounts)    
                })
            })

		let results = await Promise.all(promises)
		console.log(results);
	} catch (error) {
		console.log(error);
	}
}