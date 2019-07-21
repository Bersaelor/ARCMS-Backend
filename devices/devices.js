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
        ProjectionExpression: "sk, model, #n",
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
            name: sanitize(value.name)
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

        const response = {
            statusCode: 200,
            headers: makeHeader('application/json'),
            body: JSON.stringify(devices)
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

    let body = JSON.parse(event.body)

    try {
        console.log("brand: ", brand, ", cognitoUserName: ", cognitoUserName)
        console.log("event.body: ", body);

        const devicesPromise = loadDevicesFromDB(cognitoUserName, brand);
        const maxDevicesPromise = getMaxDevices(cognitoUserName, brand);
        const deviceData = await devicesPromise;
        const devices = deviceData.Items
        const maxDevices = await maxDevicesPromise;
        const usedDevices = devices.length
        console.log(`So far the user is using ${usedDevices} devices out of a maximum of ${maxDevices}`)


        let tomorrow = (new Date()).addDays(1);
        const response = {
            statusCode: 200,
            headers: makeHeader('application/json'),
            body: JSON.stringify({
                 "status": "Device valid",
                 "validTil": tomorrow.toISOString(),
                 "usedDevices": usedDevices,
                 "maxDevices": maxDevices,
            })
        };
    
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
            body: JSON.stringify({ "message: ": "Deletion of device " + id + " successful" })
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
