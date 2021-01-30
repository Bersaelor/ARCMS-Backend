/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const dynamoDb = new AWS.DynamoDB.DocumentClient();

Date.prototype.addDays = function(days) {
    var date = new Date(this.valueOf());
    date.setDate(date.getDate() + days);
    return date;
}

function accessLvlHasUnlimitedDevices(accessLvl) {
    return accessLvl == process.env.ACCESS_ADMIN || accessLvl == process.env.ACCESS_MANAGER;
}


async function loadDevicesFromDB(email, brand) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "sk, model, #n, lastUsed",
        KeyConditionExpression: "#id = :value and begins_with(sk, :brand)",
        ExpressionAttributeNames:{
            "#id": "id",
            "#n": "name"
        },
        ExpressionAttributeValues: {
            ":value": `${email}#device`,
            ":brand": brand
        }
    };

    return dynamoDb.query(params).promise()
}

async function getMaxDevices(cognitoUserName, brand) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "maxDevices, accessLvl",
        KeyConditionExpression: "#id = :value and sk = :brand",
        ExpressionAttributeNames:{
            "#id": "id"
        },
        ExpressionAttributeValues: {
            ":value": cognitoUserName,
            ":brand": `${brand}#user`
        }
    };

    return new Promise((resolve, reject) => {
        dynamoDb.query(params, (error, data) => {
            if (error) {
                reject(error);
            } else if (data.Items == undefined || data.Items.length < 1) {
                reject('No user named "' + cognitoUserName + '" for brand \'' + brand + '\' !');
            } else if (data.Items[0].accessLvl == undefined ) {
                reject('Entry' + data.Items[0] + 'has no accessLvl!');
            } else if (accessLvlHasUnlimitedDevices(data.Items[0].accessLvl)) {
                resolve(10000)
            } else if (data.Items[0].maxDevices == undefined ) {
                reject('Store Entry' + data.Items[0] + 'has no maxDevices!');
            } else {
                resolve(parseInt(data.Items[0].maxDevices));
            }
        });
    });
}

async function createDeviceInDB(cognitoUserName, brand, values) {
    const sanitize = (value) => ( value ? value : "n.A." ) 
    const now = new Date()
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "sk",
        Item: {
            "id": `${cognitoUserName}#device`,
            "sk": `${brand}#${values.id}`,
            "model": sanitize(values.model),
            "name": sanitize(values.name),
            "lastUsed": now.toISOString()
        }
    };

    return dynamoDb.put(params).promise();
}

async function deleteDevice(email, id, brand) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        Key: {
            "id": `${email}#device`,
            "sk": `${brand}#${id}`,
        } 
    };

    return dynamoDb.delete(params).promise()
}

function makeHeader(content) {
    return { 
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true,
        'Content-Type': content
    };
}

function mapDBEntriesToOutput(brandName, items) {
    const sanitize = (value) => ( value ? value : "n.A." ) 

    let length = brandName.length + 1
    return items.map((value) => {
        return {
            model: sanitize(value.model),
            id: value.sk.slice(length),
            name: sanitize(value.name),
            lastUsed: value.lastUsed ? value.lastUsed : (new Date(0)).toISOString()
        }
    })
}

// Get all devices for the current user
exports.all = async (event, context, callback) => {
    if (event.queryStringParameters.brand == undefined) {
        callback(null, {
            statusCode: 403,
            headers: makeHeader('text/plain'),
            body: `Missing query parameter 'brand'`,
        });
    }

    const brand = event.queryStringParameters.brand;

    if (!event.requestContext.authorizer) {
        callback(null, {
            statusCode: 403,
            headers: makeHeader('text/plain'),
            body: `Cognito Authorization missing`,
        });
    }

    const cognitoUserName = event.requestContext.authorizer.claims["cognito:username"].toLowerCase();

    try {
        const data = await loadDevicesFromDB(cognitoUserName, brand);
        const devices = mapDBEntriesToOutput(brand, data.Items)
        const sortedDevices = devices.sort((a , b) => a.lastUsed - b.lastUsed)

        const response = {
            statusCode: 200,
            headers: makeHeader('application/json'),
            body: JSON.stringify(sortedDevices)
        };
    
        callback(null, response);
    } catch(err) {
        console.error('Query failed to load data. Error JSON: ', JSON.stringify(err, null, 2));
        const response = {
            statusCode: err.statusCode || 501,
            headers: makeHeader('text/plain'),
            body: 'Failed to fetch the brands because of ' + err,
        };
        callback(null, response);
        return;
    }
};

// Check in with a device, add it if needed or reply that the user has used up his quota
exports.check = async (event, context, callback) => {
    if (event.queryStringParameters.brand == undefined) {
        callback(null, {
            statusCode: 403,
            headers: makeHeader('text/plain'),
            body: `Missing query parameter 'brand'`,
        });
    }

    const brand = event.queryStringParameters.brand;

    if (!event.requestContext.authorizer) {
        callback(null, {
            statusCode: 403,
            headers: makeHeader('text/plain'),
            body: `Cognito Authorization missing`,
        });
    }

    const cognitoUserName = event.requestContext.authorizer.claims["cognito:username"].toLowerCase();

    try {

        const body = JSON.parse(event.body)

        if (!body.id) {
            callback(null, {
                statusCode: 403,
                headers: makeHeader('text/plain'),
                body: `Missing body value id`,
            });
        }

        const newDeviceID = body.id

        const devicesPromise = loadDevicesFromDB(cognitoUserName, brand);
        const maxDevicesPromise = getMaxDevices(cognitoUserName, brand);

        const deviceData = await devicesPromise;
        const devices = mapDBEntriesToOutput(brand, deviceData.Items)
        const isExistingDevice = devices.some(v => v.id === newDeviceID)
        var usedDevices = devices.length
        var neededDevices = usedDevices + (isExistingDevice ? 0 : 1)
        const maxDevices = await maxDevicesPromise;

        var createDevicePromise
        var updateLastUsedPromise
        var deleteOldDevicePromise

        if (neededDevices > maxDevices) {
            // more devices needed then max available, check if we can remove some old devices
            const twoDaysAgo = (new Date()).addDays(-2)
            const oldestDevice = devices.sort( (a, b) => {
                return a.lastUsed > b.lastUsed ? 1 : -1
            })[0]
            console.log("Oldest Device found: ", oldestDevice)
            if (oldestDevice.lastUsed < twoDaysAgo.toISOString()) {
                console.log("Deleting device as it is last used twoDaysAgo or more")
                deleteOldDevicePromise = deleteDevice(cognitoUserName, oldestDevice.id, brand)
                usedDevices -= 1
                neededDevices -= 1
            }
        }

        if (isExistingDevice) {
            updateLastUsedPromise = createDeviceInDB(cognitoUserName, brand, body)
        } else if (!isExistingDevice && neededDevices <= maxDevices) {
            createDevicePromise = createDeviceInDB(cognitoUserName, brand, body)
            usedDevices += 1
        }

        let nextMonth = (new Date()).addDays(30);

        const response = {
            statusCode: 200,
            headers: makeHeader('application/json'),
            body: JSON.stringify({
                 "isDeviceValid": neededDevices <= maxDevices,
                 "validTil": nextMonth.toISOString(),
                 "usedDevices": usedDevices,
                 "maxDevices": maxDevices,
            })
        };

        const createDeviceSuccess = (createDevicePromise) ? await createDevicePromise : "not needed"
        const updateDeviceSuccess = (updateLastUsedPromise) ? await updateLastUsedPromise : "not needed"
        const deleteOldDeviceSuccess = (deleteOldDevicePromise) ? await deleteOldDevicePromise : "not needed"
        console.log("createDeviceSuccess: ", createDeviceSuccess, ", updateDeviceSuccess: ", updateDeviceSuccess, ", deleteOldDeviceSuccess:", deleteOldDeviceSuccess)
    
        callback(null, response);
    } catch(err) {
        console.error('Query failed. Error JSON: ', JSON.stringify(err, null, 2));
        const response = {
            statusCode: err.statusCode || 501,
            headers: makeHeader('text/plain'),
            body: 'Failed to check device because of ' + err,
        };
        callback(null, response);
        return;
    }
};


// Delete a device from the current user
exports.delete = async (event, context, callback) => {
    if (event.queryStringParameters.brand == undefined) {
        callback(null, {
            statusCode: 403,
            headers: makeHeader('text/plain'),
            body: `Missing query parameter 'brand'`,
        });
    }

    const brand = event.queryStringParameters.brand;

    if (!event.requestContext.authorizer) {
        callback(null, {
            statusCode: 403,
            headers: makeHeader('text/plain'),
            body: `Cognito Authorization missing`,
        });
    }

    const cognitoUserName = event.requestContext.authorizer.claims["cognito:username"].toLowerCase();

    const id = event.pathParameters.id

    try {
        const deletionResponse = await deleteDevice(cognitoUserName, id, brand);
        console.log("Deletion succeeded, devices: ", deletionResponse)

        const response = {
            statusCode: 200,
            headers: makeHeader('application/json'),
            body: JSON.stringify({ "message": "Deletion of device " + id + " successful" })
        };
    
        callback(null, response);
    } catch(err) {
        console.error('Query failed to load data. Error JSON: ', JSON.stringify(err, null, 2));
        const response = {
            statusCode: err.statusCode || 501,
            headers: makeHeader('text/plain'),
            body: 'Failed to delete device because of ' + err,
        };
        callback(null, response);
        return;
    }
};
