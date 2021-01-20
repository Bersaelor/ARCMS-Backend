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
            if (item.sk && item.sk.startsWith(brand)) {
                const oldCount = acc.nonVTO[item.country]
                acc.nonVTO[item.country] = oldCount !== undefined ? oldCount + 1 : 1    
            } else {
                const oldCount = acc.vto[item.country]
                acc.vto[item.country] = oldCount !== undefined ? oldCount + 1 : 1    
            }
            return acc
        }, { vto: {}, nonVTO: {}})
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
                    const nonVTO = storeCounts.nonVTO
                    var vtoFree = {}
                    var vtoPaying = {}
                    Object.keys(storeCounts.vto).forEach((countryCode) => {
                        if (settings.freeCountries.includes(countryCode)) {
                            vtoFree[countryCode] = storeCounts.vto[countryCode]
                        } else {
                            vtoPaying[countryCode] = storeCounts.vto[countryCode]
                        }
                    })
                    const totalNonFreeCountryStores = Object.values(vtoPaying).reduce((acc, item) => acc + item, 0)
                    const cost = settings.costPerStore * totalNonFreeCountryStores
                    console.log(`Brand '${brand}', cost: ${cost}, stores: `, storeCounts)
                    const parameters = {
                        nonVTO: nonVTO,
                        vtoFree: vtoFree,
                        vtoPaying: vtoPaying
                    }
                    return saveMonthlyReceiptInDB(brand, cost, parameters)    
                })
            })

		let results = await Promise.all(promises)
		console.log(results);
	} catch (error) {
		console.log(error);
	}
}