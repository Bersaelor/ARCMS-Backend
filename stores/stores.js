/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const dynamoDb = new AWS.DynamoDB.DocumentClient();

const { getAccessLvl, accessLvlMayCreate } = require('shared/access_methods')
const { paginate } = require('shared/pagination')
const { fetchCoordinates } = require('shared/get_geocoordinates')

const defaultPerPage = 80;

function makeHeader(content, maxAge = 60) {
    return { 
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true,
        'Cache-Control': `max-age=${maxAge},public`,
        'Content-Type': content
    };
}

const fetchStoresForBrand = async (brand, perPage, user, PreviousLastEvaluatedKey) => {
    const params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "id, sk, address, zipCode, city, country, telNr, email, lat, lng, company",
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
    if (user) {
        params.KeyConditionExpression = "#id = :value and begins_with(sk, :user)"
        params.ExpressionAttributeValues = {
            ":value": `${brand}#store`,
            ":user": `${user}#`
        }
    }
    const data = await dynamoDb.query(params).promise()
    const stores = data.Items && data.Items.map(convertStoredModel)
    return { LastEvaluatedKey: data.LastEvaluatedKey, stores: stores }
}

const deleteStore = async (brand, sk) => {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        Key: {
            "id": `${brand}#store`,
            "sk": sk
        } 
    };

    return dynamoDb.delete(params).promise()
}

const updateStores = async (brand, user, newStores, storesToDelete) => {
    const id = `${brand}#store`

    const puts = newStores.map((store, index) => {
        var params = {
            PutRequest: {
                Item: {
                    "id": id,
                    "sk": `${user}#${index}`,
                    "company": store.company || "",
                    "address": store.address || "",
                    "zipCode": store.zipCode || "",
                    "city": store.city || "",
                    "country": store.country || "",
                    "telNr": store.telNr || "",
                    "email": store.email || "",        
                }
            }
        }
        if (store.lat) params.PutRequest.Item.lat = store.lat
        if (store.lng) params.PutRequest.Item.lng = store.lng
        return params
    })
    const deletes = storesToDelete.map((store) => {
        return {
            DeleteRequest: {
                Key: {
                    "id": store.id,
                    "sk": store.sk    
                }
            }
        }
    })
    var params = {
        RequestItems: {
            [process.env.CANDIDATE_TABLE]: [ ...puts, ...deletes]
        }
    }
    return dynamoDb.batchWrite(params).promise()
}

const convertStoredModel = (storedModel) => {
    var model = storedModel
    model.coordinates = [storedModel.lng || 12.15, storedModel.lat || 51.15]
    delete model.lat
    delete model.lng
    return model
}

const samePlace = (storeA, storeB) => {
    return storeA.address === storeB.address && storeA.address === storeB.address && storeA.address === storeB.address
}

const addCoords = async (stores, oldStores) => {
    const fetchCooPromises = stores.map((store, index) => {
        if (index < oldStores.length && samePlace(store, oldStores[index]) && oldStores[index].lat && oldStores[index].lng) {
            console.log(`Store ${store.sk} didn't change address, reusing last lat&long`)
            var updatedStore = {...store}
            updatedStore.lat = oldStores[index].lat
            updatedStore.lng = oldStores[index].lng
            return updatedStore
        }
        if (store.address && store.zipCode && store.city) {
            return fetchCoordinates(store).then(location => {
                if (location) {
                    var updatedStore = {...store}
                    updatedStore.lat = location.lat
                    updatedStore.lng = location.lng
                    return updatedStore    
                } else {
                    console.log(`Failed to get location for store ${store.sk}`)
                    return store
                }
            })      
        } else {
            console.log(`Can't fetch address for store ${store.sk}`)
            return store
        }
    })
    return Promise.all(fetchCooPromises)
}

// Get an array of stores, given a brand and optionally user, paginated
exports.get = async (event, context, callback) => {
    const brand = event.pathParameters.brand.toLowerCase()
    const user = event.queryStringParameters && event.queryStringParameters.user;
    var PreviousLastEvaluatedKey
    if (event.queryStringParameters && event.queryStringParameters.nextPageKey) {
        let jsonString = Buffer.from(event.queryStringParameters.nextPageKey, 'base64').toString('ascii')
        PreviousLastEvaluatedKey = JSON.parse(jsonString)
    }

    if (!brand) {
        callback(null, {
            statusCode: 403,
            headers: makeHeader('text/plain'),
            body: `Expected a brand in the call.`,
        });
        return;
    }

    try {
        var perPage = event.queryStringParameters && event.queryStringParameters.perPage ? parseInt(event.queryStringParameters.perPage, 10) : undefined;
        if (!perPage || perPage > 4 * defaultPerPage) {
            perPage = 4 * defaultPerPage
        }

        console.log("Fetching stores for brand ", brand, " and user ", user)
        const data = await fetchStoresForBrand(brand, perPage, user, PreviousLastEvaluatedKey)

        // respond with 1 day caching
        const day = 60 * 60 * 24
        callback(null, {
            statusCode: 200,
            headers: makeHeader('application/json', day),
            body: JSON.stringify(paginate(data.stores, perPage, data.LastEvaluatedKey))
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

// Post an array of stores for a given user and brand
exports.new = async (event, context, callback) => {
    const cognitoUserName = event.requestContext.authorizer.claims["cognito:username"].toLowerCase();
    const brand = event.pathParameters.brand.toLowerCase()
    const user = event.pathParameters.user.toLowerCase()
    var newStores = JSON.parse(event.body)

    try {
        // fetch the existing entries, to determine whether entries have to be removed
        const dataPromise = fetchStoresForBrand(brand, defaultPerPage, user, undefined)
        const accessLvlPromise = getAccessLvl(cognitoUserName, brand);
        // make sure the current cognito user has high enough access lvl
        const accessLvl = await accessLvlPromise
        // users who aren't managers can update their own store entries
        if (!accessLvlMayCreate(accessLvl) && cognitoUserName.toLowerCase() !== user.toLowerCase()) {
            const msg = `user ${cognitoUserName} isn't allowed to create or update categories for ${user}`
            callback(null, {
                statusCode: 403,
                headers: makeHeader('application/json'),
                body: JSON.stringify({ "message": msg })
            });
            return;
        }

        const oldStores = (await dataPromise).stores
        const storesToDelete = oldStores.length > newStores.length ? oldStores.slice(newStores.length) : []
        console.log(`Fetching coordinates of ${newStores.length} stores`)
        newStores = await addCoords(newStores, oldStores)
        console.log(`Overwriting ${newStores.length}, deleting ${storesToDelete} old stores`)

        const status = await updateStores(brand, user, newStores, storesToDelete)
        console.log("Status response: ", status)
        callback(null, {
            statusCode: 200,
            headers: makeHeader('application/json' ),
            body: JSON.stringify({
                "message": `Updated ${newStores.length}, deleted ${storesToDelete.length} old stores`,
            })
        });
    } catch (error) {
        console.error('Query failed to load data. Error: ', error);
        callback(null, {
            statusCode: error.statusCode || 501,
            headers: makeHeader('text/plain'),
            body: `Encountered error ${error}`,
        });
        return;
    }
}

// Delete store from the db
exports.delete = async (event, context, callback) => {

}