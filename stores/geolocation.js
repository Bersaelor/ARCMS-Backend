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
    console.log("fetchStoresForBrand.params: ", params)
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
        stores = stores.concat(data.Items)
    } while (LastEvaluatedKey !== undefined)
    return stores
}

const fetchCoordinates = async (store) => {
    const address = encodeURI(`${store.address} ${store.zipCode} ${store.city}`)
	const response = await fetch(
        `https://maps.googleapis.com/maps/api/geocode/json?key=${process.env.GOOGLE_KEY}&address=${address}`,
        {method: 'GET'});
	const json = await response.json();
    console.log("Receieved response: ", json)
    return json.geometry.location
}

const writeEntryToTable = async (brand, store, location) => {
    const config = new ddbGeo.GeoDataManagerConfiguration(ddb, tableName(brand))
    config.hashKeyLength = haskKeyLength
    const myGeoTableManager = new ddbGeo.GeoDataManager(config)

    myGeoTableManager.putPoint({
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
            country: { S: store.country },
            telNr: { S: store.telNr },
            email: { S: store.email }
          },
        }
      }).promise()
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
        console.log("response: ", response);

        const storePromises = response[1].map(store => {
            return fetchCoordinates(store).then(location => {
                return writeEntryToTable(brand, store, location)
            })  
        })
        const puts = Promise.all(storePromises)

        callback(null, {
            body: `Created ${puts.length} store entries`,
        });
    } catch(error) {
        console.error('Query failed to load data. Error: ', error);
        callback(null, {
            statusCode: error.statusCode || 501,
            body: `Encountered error ${error}`,
        });
        return;
    }
}