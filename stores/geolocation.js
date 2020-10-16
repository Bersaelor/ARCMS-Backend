/*jslint node: true */

'use strict';

const AWS = require('aws-sdk')
AWS.config.update({region: process.env.AWS_REGION})

const { getAccessLvl, accessLvlMayCreate } = require('shared/access_methods')

const cloudfront = new AWS.CloudFront;
const ddb = new AWS.DynamoDB() 
const dynamoDb = new AWS.DynamoDB.DocumentClient();
const ddbGeo = require('dynamodb-geo')
const haskKeyLength = 4

function tableName(brand) {
    return `arcms-geo-${brand}`
}

function makeHeader(content) {
    return { 
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true,
        'Content-Type': content
    };
}

const deleteTable = async (brand) => {
    try {
        const response = await ddb.deleteTable({ TableName: tableName(brand)}).promise().then((response) => {
            console.log("Deleted table: ", response)
            return ddb.waitFor('tableNotExists', { TableName: tableName(brand) }).promise()
        })
        console.log("Waited for table to disappear: ", response)
    } catch(error) {
        if (error.code === 'ResourceNotFoundException') {
            console.log("Table doesn't exist, no need to delete")
        } else {
            throw error
        }
    }
}

const createTable = async (brand) => {
    const config = new ddbGeo.GeoDataManagerConfiguration(ddb, tableName(brand))
    config.hashKeyLength = haskKeyLength

    const createTableInput = ddbGeo.GeoTableUtil.getCreateTableRequest(config);

    // Create the table
    return ddb.createTable(createTableInput).promise()
        .then(function () { return ddb.waitFor('tableExists', { TableName: config.tableName }).promise() })
}

const fetchStoresForBrand = async (brand, perPage, PreviousLastEvaluatedKey) => {
    const params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "id, sk, address, company, zipCode, city, country, web, telNr, email, lat, lng",
        KeyConditionExpression: "#id = :value",
        ExpressionAttributeNames:{
            "#id": "id"
        },
        ExpressionAttributeValues: {
            ":value": `${brand}#store`
        },
        Limit: perPage,
    }; 
    if (PreviousLastEvaluatedKey) { params.ExclusiveStartKey = PreviousLastEvaluatedKey }
    const data = await dynamoDb.query(params).promise()
    return { LastEvaluatedKey: data.LastEvaluatedKey, stores: data.Items }
}

const fetchAllStoresForBrand = async (brand) => {
    var LastEvaluatedKey
    var defaultPerPage = 80
    var stores = []
    do {
        const data = await fetchStoresForBrand(brand, defaultPerPage, LastEvaluatedKey)
        LastEvaluatedKey = data.LastEvaluatedKey
        stores = stores.concat(data.stores)
    } while (LastEvaluatedKey !== undefined)
    return stores
}

const writeEntryToTable = async (brand, store) => {
    const config = new ddbGeo.GeoDataManagerConfiguration(ddb, tableName(brand))
    config.hashKeyLength = haskKeyLength
    const myGeoTableManager = new ddbGeo.GeoDataManager(config)

    const params = {
        RangeKeyValue: { S: `${store.id}#${store.sk}` },
        GeoPoint: {
            latitude: store.lat,
            longitude: store.lng
        },
        PutItemInput: {
            Item: {
                address: { S: store.address },
                company: { S: store.company },
                zipCode: { S: store.zipCode },
                city: { S: store.city },
                country: { S: store.country || "" },
                web: { S: store.web || "" },
                telNr: { S: store.telNr || "" },
                email: { S: store.email || "" },
                isVTO: { BOOL: store.sk && !store.sk.startsWith(brand)  }
            },
        }
    }
    myGeoTableManager.putPoint(params).promise()
}

const findStoresOnMap = async (brand, minLat, minLng, maxLat, maxLng) => {
    const config = new ddbGeo.GeoDataManagerConfiguration(ddb, tableName(brand))
    config.hashKeyLength = haskKeyLength
    const myGeoTableManager = new ddbGeo.GeoDataManager(config)

    return myGeoTableManager.queryRectangle({
        MinPoint: {
            latitude: minLat,
            longitude: minLng
        },
        MaxPoint: {
            latitude: maxLat,
            longitude: maxLng
        }
    }).then((stores) => {
        return stores.map(v => convertMapAttribute(v))
    })
}

const convertMapAttribute = (dbEntry) => {
    var store = {}
    store.id = `${dbEntry.hashKey.N}-${dbEntry.rangeKey.S}`
    store.address = dbEntry.address.S
    store.zipCode = dbEntry.zipCode.S
    store.city = dbEntry.city.S
    store.country = dbEntry.country.S
    if (dbEntry.company) store.company = dbEntry.company.S
    store.web = dbEntry.web && dbEntry.web.S
    store.telNr = dbEntry.telNr && dbEntry.telNr.S
    store.email = dbEntry.email && dbEntry.email.S
    store.coordinates = JSON.parse(dbEntry.geoJson.S).coordinates
    store.isVTO = dbEntry.isVTO.BOOL
    return store
}

async function invalidateStoreCache(brand) {
    return new Promise((resolve, reject) => {
        const now = new Date()
        const params = { 
            DistributionId: "E2B3LFAX7VM8JV",
            InvalidationBatch: {
                CallerReference: `${now.getTime()}`,
                Paths: {
                  Quantity: '2',
                  Items: [
                    `/${brand}/stores*`,
                    `/stores/geo/${brand}*`
                  ]
                }
            }
        }
        cloudfront.createInvalidation(params, (err, data) => {
            if (err) reject(err)
            else resolve(data)
        })
    });
}

exports.populate = async (event, context, callback) => {
    const cognitoUserName = event.requestContext.authorizer.claims["cognito:username"].toLowerCase();
    const brand = event.pathParameters.brand.toLowerCase()

    try {
        const accessLvl = await getAccessLvl(cognitoUserName, brand)

        if (!accessLvlMayCreate(accessLvl)) {
            const msg = `The ${cognitoUserName} isn't allowed to look at the statistics`
            callback(null, {
                statusCode: 403,
                headers: makeHeader('application/json' ),
                body: JSON.stringify({ "message": msg })
            });
            return;
        }

        const createTablePromise = deleteTable(brand).then(() => {
            return createTable(brand)
        }) 
        const storesPromise = fetchAllStoresForBrand(brand)
        const response = await Promise.all([createTablePromise, storesPromise])

        const storePromises = response[1].map(store => {
            if (store.lat && store.lng) {
                return writeEntryToTable(brand, store)    
            } else {
                return {}
            }
        })
        const puts = await Promise.all(storePromises)
        const invalidation = await invalidateStoreCache(brand)

        callback(null, {
            statusCode: 200,
            headers: makeHeader('application/json' ),
            body: JSON.stringify({
                "message": `Created ${puts.length} store entries, invalidation: ${invalidation}`,
            })
        });
    } catch(error) {
        console.error('Query failed to load data. Error: ', error);
        callback(null, {
            statusCode: error.statusCode || 501,
            headers: makeHeader('text/plain'),
            body: `Encountered error ${error}`,
        });
        return;
    }
}

const parseFloatQuery = (event, name) => {
    if (event.queryStringParameters && event.queryStringParameters[name]) {
        return parseFloat(event.queryStringParameters[name])
    }
    return undefined
}

// Get store locations on the map
exports.get = async (event, context, callback) => {
    const brand = event.pathParameters.brand.toLowerCase()
    const minLat = parseFloatQuery(event, 'minLat')
    const minLng = parseFloatQuery(event, 'minLng')
    const maxLat = parseFloatQuery(event, 'maxLat')
    const maxLng = parseFloatQuery(event, 'maxLng')

    if (minLat === undefined || minLng === undefined || maxLat === undefined || maxLng === undefined) {
        callback(null, {
            statusCode: 403,
            headers: makeHeader('text/plain'),
            body: `Expected minLat, minLng, maxLat & maxLng as query params.`,
        });
        return;
    }

    try {
        console.log("Fetching stores for brand ", brand, ` Lat: ${minLat} - ${maxLat}, Long: ${minLng} - ${maxLng}`)
        const stores = await findStoresOnMap(
            brand, minLat, minLng, maxLat, maxLng
        )

        callback(null, {
            statusCode: 200,
            headers: makeHeader('application/json' ),
            body: JSON.stringify(stores)
        });
    } catch(err) {
        console.error('Query failed to load data. Error: ', err);
        callback(null, {
            statusCode: err.statusCode || 501,
            headers: makeHeader('text/plain'),
            body: `Encountered error ${err}`,
        });
        return;
    }
}