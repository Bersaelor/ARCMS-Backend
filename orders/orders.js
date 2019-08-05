/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const dynamoDb = new AWS.DynamoDB.DocumentClient();
const sns = new AWS.SNS();

async function loadUserOrdersFromDB(brand, email) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "id, sk, contact, orderJSON",
        KeyConditionExpression: "#id = :value and begins_with(sk, :user)",
        ExpressionAttributeNames:{
            "#id": "id",
        },
        ExpressionAttributeValues: {
            ":value": `${brand}#order`,
            ":user": email
        }
    };

    return dynamoDb.query(params).promise()
}

async function loadAllOrdersFromDB(brand) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "id, sk, contact, orderJSON",
        KeyConditionExpression: "#id = :value",
        ExpressionAttributeNames:{
            "#id": "id",
        },
        ExpressionAttributeValues: {
            ":value": `${brand}#order`,
        }
    };

    return dynamoDb.query(params).promise()
}

async function writeOrderToDB(cognitoUserName, brand, orderString, contactName, orderSK) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "sk",
        Item: {
            "id": `${brand}#order`,
            "sk": orderSK,
            "contact": contactName,
            "orderJSON": orderString
        }
    };

    return dynamoDb.put(params).promise();
}

async function getAccessLvl(cognitoUserName, brand) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "accessLvl",
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
                reject(error)
                return;
            } else if (data.Items == undefined || data.Items.length < 1) {
                reject('No user named "' + cognitoUserName + '" for brand \'' + brand + '\' !')
                return;
            } else if (data.Items[0].accessLvl == undefined ) {
                reject('Entry' + data.Items[0] + 'has no accessLvl!');
                return;
            } else {
                resolve(data.Items[0].accessLvl);
            }
        });
    });
}

async function getContactName(cognitoUserName, brand) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "firstName, lastName",
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
            console.log("Contactname query data: ", data)
            if (error) {
                reject(error);
                return;
            } else if (data.Items == undefined || data.Items.length < 1) {
                reject('No user named "' + cognitoUserName + '" for brand \'' + brand + '\' !');
                return;
            } else {
                resolve(`${data.Items.firstName ? data.Items.firstName : "?"} ${data.Items.lastName ? data.Items.lastName : "?"}`);
            }
        });
    });
}

function makeHeader(content) {
    return { 
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true,
        'Content-Type': content
    };
}

function mapDBEntriesToOutput(items) {
    const sanitize = (value) => ( value ? value : "n.A." ) 

    return items.map((value) => {
        const dividerPos = value.sk.indexOf('#')
        return {
            date: value.sk.substring(dividerPos+1, dividerPos.length),
            store: value.sk.substring(0, dividerPos),
            contact: sanitize(value.contact),
            content: JSON.parse(value.orderJSON)
        }
    })
}

function accessLvlMaySeeAllOrders(accessLvl) {
    return accessLvl == process.env.ACCESS_ADMIN || accessLvl == process.env.ACCESS_MANAGER;
}

// Get all orders for the current user or brand depending on the accessLvl
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

    const askingForStoreOnly = event.queryStringParameters.store && event.queryStringParameters.store === "true"

    if (askingForStoreOnly) {
        await replyWithUserOrders(brand, cognitoUserName, callback)
    } else {
        await replyWithAllOrders(brand, cognitoUserName, callback)
    }
};

async function replyWithUserOrders(brand, cognitoUserName, callback) {
    try {
        const data = await loadUserOrdersFromDB(brand, cognitoUserName);
        const orders = mapDBEntriesToOutput(data.Items)

        const response = {
            statusCode: 200,
            headers: makeHeader('application/json'),
            body: JSON.stringify(orders)
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
}

async function replyWithAllOrders(brand, cognitoUserName, callback) {
    try {
        const accessLvlPromise = getAccessLvl(cognitoUserName, brand)
        const dataPromise = loadAllOrdersFromDB(brand)

        const ownAccessLvl = await accessLvlPromise;
        if (!accessLvlMaySeeAllOrders(ownAccessLvl)) {
            callback(null, {
                statusCode: 403,
                headers: makeHeader('text/plain'),
                body: `User ${cognitoUserName} is not allowed to see all orders for ${brand}`,
            });
            return;
        }

        const data = await dataPromise
        const orders = mapDBEntriesToOutput(data.Items)

        const response = {
            statusCode: 200,
            headers: makeHeader('application/json'),
            body: JSON.stringify(orders)
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
}

async function postNewOrderNotification(orderString, storeEmail, brand, orderSK) {
    var params = {
        Message: orderString, 
        Subject: "New glasses order",
        TopicArn: process.env.snsArn,
        MessageAttributes: {
            'storeEmail': {
                DataType: 'String',
                StringValue: storeEmail
            },
            'brand': {
                DataType: 'String',
                StringValue: brand
            },
            'orderSK': {
                DataType: 'String',
                StringValue: orderSK
            }
        }
    };
    return sns.publish(params).promise()
}


// Create and save a new order
exports.create = async (event, context, callback) => {
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

        if (!body) {
            callback(null, {
                statusCode: 403,
                headers: makeHeader('text/plain'),
                body: `Missing body value`,
            });
            return
        }
    
        const bodyString = JSON.stringify(body)
    
        const contactName = await getContactName(cognitoUserName, brand)

        console.log("writeSuccess: ", contactName)

        const now = new Date()
        const orderSK = `${cognitoUserName}#${now.toISOString()}`
        const writeSuccessPromise = writeOrderToDB(cognitoUserName, brand, bodyString, contactName, orderSK)
        const notifiyViaEmailPromise = postNewOrderNotification(bodyString, cognitoUserName, brand, orderSK)

        const writeSuccess = await writeSuccessPromise
        const notificationSuccess = await notifiyViaEmailPromise
        console.log("writeSuccess: ", writeSuccess, ", notificationSuccess: ", notificationSuccess)

        const response = {
            statusCode: 200,
            headers: makeHeader('application/json'),
            body: JSON.stringify({ 
                "message": "Creation of order successful",
                "isSuccessful": true
            })
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
