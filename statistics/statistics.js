/*jslint node: true */

'use strict';

const aws = require('aws-sdk'); 
aws.config.update({region: process.env.AWS_REGION})
const AthenaExpress = require("athena-express");
const brandSettings = require('brand_settings.json')
const { getAccessLvl, accessLvlMayCreate } = require('shared/access_methods')

const apic_log_table = 'apic_cloudfront_logs'
const ATHENA_OUTPUT_LOCATION = 's3://looc-ar-api-statistics/query-results/'

const athenaExpressConfig = {
	aws, /* required */
    db: 'default',
	s3: ATHENA_OUTPUT_LOCATION, /* optional */
	formatJson: true, /* optional default=true */
	retry: 200, /* optional default=200 */
    getStats: false /* optional default=false */
};
const athenaExpress = new AthenaExpress(athenaExpressConfig);
const dynamoDb = new aws.DynamoDB.DocumentClient();
const s3 = new aws.S3();

const RESULT_SIZE = 1000

const dateToSQL = (date) => {
    return date.toISOString().split('T')[0]
}

// from https://en.wikipedia.org/wiki/Darwin_(operating_system)
const iOSVersions = {
    "18.0.0": "12.0",
    "18.2.0": "12.1",
    "18.7.0": "12.4",
    "19.0.0": "13.0",
    "19.2.0": "13.3",
    "19.3.0": "13.3.1",
    "19.4.0": "13.4",
    "19.5.0": "13.5",
    "19.6.0": "13.6",
    "20.0.0": "14.0",
    "20.1.0": "14.2",
    "20.2.0": "14.3",
    "20.3.0": "14.4"
}

function makeHeader(content) {
    return { 
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true,
        'Content-Type': content
    };
}

const getBrandAppDataHits = async (brand, from, to, appAgentName) => {
    let query = {
        sql: `\
        SELECT user_agent\
        FROM ${apic_log_table} \
        WHERE \
        (\
        "date" BETWEEN DATE '${dateToSQL(from)}' AND DATE '${dateToSQL(to)}' AND\
        "uri" LIKE '%${brand}/app-data%' AND\
        "user_agent" LIKE '${appAgentName}%' AND\
        "query_string" = '-'\
        )\
        LIMIT ${RESULT_SIZE};\
        `
    }

    return athenaExpress.query(query)
}

const getStoresOnMapHits = async (brand, from, to, appAgentName) => {
    let query = {
        sql: `\
        SELECT COUNT(user_agent)\
        FROM ${apic_log_table} \
        WHERE \
        (\
        "date" BETWEEN DATE '${dateToSQL(from)}' AND DATE '${dateToSQL(to)}' AND\
        "uri" LIKE '%stores/geo/${brand}%' AND\
        "user_agent" LIKE '${appAgentName}%'\
        )\
        LIMIT ${RESULT_SIZE};\
        `
    }

    return athenaExpress.query(query).then(data => {
        return data.Items && data.Items.length > 0 && data.Items[0]._col0 || 0
    })
}

async function loadAllOrdersFromDB(brand, from, to) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        IndexName: "id-sk2-index",
        ProjectionExpression: "id, sk, sk2, isTesting, orderJSON",
        KeyConditionExpression: "#id = :value AND sk2 BETWEEN :from AND :to",
        FilterExpression: "attribute_not_exists(#isTesting) or #isTesting = :null",
        ExpressionAttributeNames:{
            "#id": "id",
            "#isTesting": "isTesting",
        },
        ExpressionAttributeValues: {
            ":value": `${brand}#order`,
            ":from": dateToSQL(from),
            ":to": dateToSQL(to),
            ":null": null
        },
        ScanIndexForward: false
    };

    return dynamoDb.query(params).promise().then(data => {
        if (!data.Items || data.Items.length < 1) return 0
        return data.Items.reduce((acc, item) => {
            let order = JSON.parse(item.orderJSON)
            return acc + order.length
        }, 0)
    })
}

const getStats = async (brand, fromDate, toDate) => {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "sk, appData, mapHits, orderCount",
        KeyConditionExpression: "#id = :value AND #sk BETWEEN :from AND :to",
        ExpressionAttributeNames:{
            "#id": "id",
            "#sk": "sk"
        },
        ExpressionAttributeValues: {
            ":value": `${brand}#stats`,
            ":from": dateToSQL(fromDate),
            ":to": dateToSQL(toDate)
        },
    };

    return dynamoDb.query(params).promise().then(data => {
        return data.Items.map(item => {
            return {
                date: item.sk,
                orderCount: item.orderCount || 0,
                mapHits: item.mapHits || 0,
                appData: item.appData && JSON.parse(item.appData) || {}
            }
        })
    })
}

const analyzeAgentArray = (userAgents) => {
    var appVersions = {}
    var osVersions = {}

    userAgents.forEach(element => {
        let parts = element.split('%20')
        if (parts && parts.length > 2) {
            let appAndVersion = parts[0].split('/')
            if (appAndVersion.length > 1) {
                let appVersion = appAndVersion[1]
                appVersions[appVersion] = appVersions[appVersion] === undefined ? 1 : appVersions[appVersion] + 1
            }
            var osVersion = 'unknown'
            let darwinAndVersion = parts[2].split('/')
            if (darwinAndVersion.length > 1 && darwinAndVersion[0] === "Darwin" && iOSVersions[darwinAndVersion[1]]) {
                osVersion = `iOS ${iOSVersions[darwinAndVersion[1]]}`
            }
            osVersions[osVersion] = osVersions[osVersion] === undefined ? 1 : osVersions[osVersion] + 1
        }
    });

    return {
        appVersions: appVersions,
        osVersions: osVersions,
        total: userAgents.length
    }
}

const writeToDb = async (brand, day, appDataAnalysis, orderCount, mapHits) => {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        Item: {
            "id": `${brand}#stats`,
            "sk": `${day.toISOString()}`,
            "appData": JSON.stringify(appDataAnalysis),
            "orderCount": orderCount,
            "mapHits": mapHits
        }
    };

    return dynamoDb.put(params).promise();
}

const writeDiskUsageToDB = async (brand, date, size) => {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        Item: {
            "id": `${brand}#diskusage`,
            "sk": `${date.toISOString()}`,
            "sizeInBytes": size
        }
    };

    return dynamoDb.put(params).promise();
}

const getLatestDiskUsage = async (brand) => {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "sk, sizeInBytes",
        KeyConditionExpression: "#id = :value",
        Limit: 1,
        ExpressionAttributeNames:{
            "#id": "id"
        },
        ExpressionAttributeValues: {
            ":value": `${brand}#diskusage`,
        },
        ScanIndexForward: false
    };

    return dynamoDb.query(params).promise().then(data => {
        if (data.Items && data.Items.length > 0) {
            return {
                size: data.Items[0].sizeInBytes,
                date: data.Items[0].sk
            }
        } else {
            return undefined
        }
    })
}

function getS3Content(bucket, continuationToken) {
    var params = {
        Bucket: bucket,
        MaxKeys: 1000,
    }

    if (continuationToken) {
        params.ContinuationToken = continuationToken
    }

    return s3.listObjectsV2(params).promise()
}

async function getAllS3ContentByBrand() {
    var continuationToken
    var brandSizes = {}
    do {
        const data = await getS3Content(process.env.MODEL_BUCKET, continuationToken)
        continuationToken = data.NextContinuationToken
        data.Contents.forEach(object => {
            var components = object.Key.split('/')
            if (components.length > 1) {
                var brand = components[1]
                if (brandSizes[brand] != null) {
                    brandSizes[brand] += object.Size
                } else {
                    brandSizes[brand] = object.Size
                }
            }
        })
    } while (continuationToken !== undefined)
    return brandSizes
}

// Queries the cloudfront logs for the appData
exports.appData = async (event, context, callback) => {
    var day = new Date(event.time) 
    day.setHours(1, 0, 0, 0)

    var dayBefore = new Date(day.getTime())
    dayBefore.setDate(day.getDate() - 1)

    try {
        const brands = Object.keys(brandSettings)

        let promises = brands
            .filter(brand => brandSettings[brand].AppAgentName !== undefined)
            .map(brand => {
                const appDataPromise = getBrandAppDataHits(brand, dayBefore, day, brandSettings[brand].AppAgentName)
                    .then(data => {
                        const userAgents = data.Items.map(item => item.user_agent)
                        return analyzeAgentArray(userAgents)
                    })
                const mapRequestsPromise = getStoresOnMapHits(brand, dayBefore, day, brandSettings[brand].AppAgentName)
                const orderCountPromise = loadAllOrdersFromDB(brand, dayBefore, day)
                return Promise.all([appDataPromise, orderCountPromise, mapRequestsPromise]).then( values => {
                    const [appDataAnalysis, orderCount, mapHits] = values
                    return writeToDb(brand, dayBefore, appDataAnalysis, orderCount, mapHits)
                })
            })

		let results = await Promise.all(promises)
		console.log(results);
	} catch (error) {
		console.log(error);
	}
}

// Queries S3 for each brands disk space usage
exports.cmsUsage = async (event, context, callback) => {
    try {
        var brandSizes = await getAllS3ContentByBrand()

        var date = new Date(event.time) 
        
        var writeToDBPromises = Object.keys(brandSettings).map(brand => {
            return writeDiskUsageToDB(brand, date, brandSizes[brand])
        })

		let results = await Promise.all(writeToDBPromises)
		console.log(results);
	} catch (error) {
		console.log(error);
	}
}

// Get the latest disk usage for a given brand
exports.getDiskUsage = async (event, context, callback) => {
    const brand = event.pathParameters.brand.toLowerCase()

    if (!brand) {
        callback(null, {
            statusCode: 403,
            headers: makeHeader('text/plain'),
            body: `Expected a brand in the call.`,
        });
        return;
    }    

    console.log("Checking for disk usage of ", brand)
    try {
        const value = await getLatestDiskUsage(brand)
    
        if (value) {
            callback(null, {
                statusCode: 200,
                headers: makeHeader('application/json'),
                body: JSON.stringify({
                    message: `${brand} is using ${(value.size / (1024 * 1024)).toFixed(2)} MB`,
                    sizeInBytes: value.size,
                    date: value.date
                })
            });    
        } else {
            callback(null, {
                statusCode: 404,
                headers: makeHeader('application/json'),
                body: JSON.stringify({
                    message: `for ${brand} disk usage hasn't been recorded yet`,
                    sizeInBytes: 0,
                    date: "-"
                })
            });
        }
    } catch(error) {
        console.error('Query failed to get disk usage. Error JSON: ', JSON.stringify(error, null, 2));
        callback(null, {
            statusCode: error.statusCode || 501,
            headers: makeHeader('text/plain'),
            body: `Encountered error ${error}`,
        });
        return;
    }
}

//  Gets a list of app statistics for a given date range
exports.get = async (event, context, callback) => {
    const cognitoUserName = event.requestContext.authorizer.claims["cognito:username"].toLowerCase();
    const brand = event.pathParameters.brand.toLowerCase()

    const from = event.queryStringParameters && event.queryStringParameters.from;
    const to = event.queryStringParameters && event.queryStringParameters.to;

    if (!brand || !from || !to) {
        callback(null, {
            statusCode: 403,
            headers: makeHeader('text/plain'),
            body: `Expected a brand, from and to parameter in the call.`,
        });
        return;
    }    

    console.log("Checking for statistics for ", brand, ", from ", from, " to ", to)
    try {
        const accessLvlPromise = getAccessLvl(cognitoUserName, brand)

        var fromDate = new Date(from)
        fromDate.setHours(0, 0, 0, 0)
        var toDate = new Date(to)
        toDate.setDate(toDate.getDate() + 1)
        toDate.setHours(0, 0, 0, 0)

        const itemPromise = getStats(brand, fromDate, toDate)

        const [items, accessLvl] = await Promise.all([itemPromise, accessLvlPromise])

        console.log("accessLvl: ", accessLvl)

        if (!accessLvlMayCreate(accessLvl)) {
            const msg = `The ${cognitoUserName} isn't allowed to view the app statistics`
            callback(null, {
                statusCode: 403,
                headers: makeHeader('application/json' ),
                body: JSON.stringify({ "message": msg })
            });
            return;
        }
    
        callback(null, {
            statusCode: 200,
            headers: makeHeader('application/json'),
            body: JSON.stringify(items)
        });
    } catch(error) {
        console.error('Query failed to delete. Error JSON: ', JSON.stringify(error, null, 2));
        callback(null, {
            statusCode: error.statusCode || 501,
            headers: makeHeader('text/plain'),
            body: `Encountered error ${error}`,
        });
        return;
    }
}