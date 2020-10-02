/*jslint node: true */

'use strict';

const AWS = require('aws-sdk')
AWS.config.update({region: process.env.AWS_REGION})

const { getAccessLvl, accessLvlMayCreate } = require('shared/access_methods')

const ddb = new AWS.DynamoDB() 
const dynamoDb = new AWS.DynamoDB.DocumentClient();
const ddbGeo = require('dynamodb-geo')
const haskKeyLength = 5

const fetch = require('node-fetch');

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
        ProjectionExpression: "id, sk, address, zipCode, city, country, telNr, email",
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

const fetchCoordinates = async (store) => {
    const address = encodeURI(`${store.address} ${store.zipCode} ${store.city}`)
	const response = await fetch(
        `https://maps.googleapis.com/maps/api/geocode/json?key=${process.env.GOOGLE_KEY}&address=${address}`,
        {method: 'GET'});
	const json = await response.json();
    if (json && json.results && json.results.length > 0 && json.results[0].geometry && json.results[0].geometry.location) {
        return json.results[0].geometry.location
    } else {
        console.log(`No location found for:`, store.sk)
        return undefined
    }
}

const writeEntryToTable = async (brand, store, location) => {
    const config = new ddbGeo.GeoDataManagerConfiguration(ddb, tableName(brand))
    config.hashKeyLength = haskKeyLength
    const myGeoTableManager = new ddbGeo.GeoDataManager(config)

    const params = {
        RangeKeyValue: { S: `${store.id}#${store.sk}` },
        GeoPoint: {
            latitude: location.lat,
            longitude: location.lng
        },
        PutItemInput: {
            Item: {
                address: { S: store.address },
                zipCode: { S: store.zipCode },
                city: { S: store.city },
                country: { S: store.country || "" },
                telNr: { S: store.telNr || "" },
                email: { S: store.email || "" }
            },
        }
    }
    console.dir(params, { depth: null });
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
        console.log("stores: ", stores)
        return stores.map(v => convertMapAttribute(v))
    })
}

const convertMapAttribute = (dbEntry) => {
    const store = {...dbEntry}
    return store
}

exports.populate = async (event, context, callback) => {
    const cognitoUserName = event.requestContext.authorizer.claims["cognito:username"].toLowerCase();
    const brand = event.pathParameters.brand.toLowerCase()

    try {
        const accessLvl = await getAccessLvl(cognitoUserName, brand)

        if (!accessLvlMayCreate(accessLvl)) {
            const msg = `The ${cognitoUserName} isn't allowed to populate the geo locations`
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
            if (store.address && store.zipCode && store.city) {
                return fetchCoordinates(store).then(location => {
                    if (location) {
                        return writeEntryToTable(brand, store, location)    
                    } else {
                        return {}
                    }
                })      
            } else {
                return {}
            }
        })
        const puts = Promise.all(storePromises)

        callback(null, {
            statusCode: 200,
            headers: makeHeader('application/json' ),
            body: JSON.stringify({
                "message": `Created ${puts.length} store entries`,
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