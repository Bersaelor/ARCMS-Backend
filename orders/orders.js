/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const dynamoDb = new AWS.DynamoDB.DocumentClient();
const sns = new AWS.SNS();

const defaultPerPage = 20;

async function loadUserOrdersFromDB(brand, email, perPage = defaultPerPage) {
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
        },
        Limit: perPage,
        ScanIndexForward: false
    };

    return dynamoDb.query(params).promise()
}

async function loadAllOrdersFromDB(brand, perPage = defaultPerPage) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        IndexName: "id-sk2-index",
        ProjectionExpression: "id, sk, sk2, contact, orderJSON",
        KeyConditionExpression: "#id = :value",
        ExpressionAttributeNames:{
            "#id": "id",
        },
        ExpressionAttributeValues: {
            ":value": `${brand}#order`,
        },
        Limit: perPage,
        ScanIndexForward: false
    };

    return dynamoDb.query(params).promise()
}

async function loadOrderFromDB(brand, orderSK) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "id, sk, contact, orderJSON",
        KeyConditionExpression: "#id = :value and sk = :orderSK",
        ExpressionAttributeNames:{
            "#id": "id",
        },
        ExpressionAttributeValues: {
            ":value": `${brand}#order`,
            ":orderSK": orderSK
        },
        ScanIndexForward: false
    };

    return dynamoDb.query(params).promise()
}

async function writeOrderToDB(cognitoUserName, brand, orderString, contactName, orderSK) {
    const email = orderSK.split('#')[0]
    const timeString = orderSK.split('#')[1]

    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "sk",
        Item: {
            "id": `${brand}#order`,
            "sk": orderSK,
            "sk2": `${timeString}#${email}`,
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

// Get a specific order based on brand, user and timeStamp
exports.order = async (event, context, callback) => {
    if (event.queryStringParameters.brand == undefined) {
        callback(null, {
            statusCode: 403,
            headers: makeHeader('text/plain'),
            body: `Missing query parameter 'brand'`,
        });
        return;
    }
    const brand = event.queryStringParameters.brand;

    if (!event.requestContext.authorizer) {
        callback(null, {
            statusCode: 403,
            headers: makeHeader('text/plain'),
            body: `Cognito Authorization missing`,
        });
        return;
    }
    const cognitoUserName = event.requestContext.authorizer.claims["cognito:username"].toLowerCase();

    const id = event.pathParameters.id
    const orderSK = decodeURIComponent(id)
    const customer = orderSK.split('#')[0]
    const needsManagerAccess = customer != cognitoUserName

    try {
        const ownAccessLvl = needsManagerAccess ? await getAccessLvl(cognitoUserName, brand) : undefined
        if (needsManagerAccess && !accessLvlMaySeeAllOrders(ownAccessLvl)) {
            callback(null, {
                statusCode: 403,
                headers: makeHeader('text/plain'),
                body: `User ${cognitoUserName} is not allowed to see all orders for ${brand}`,
            });
            return;
        }

        const data = await loadOrderFromDB(brand, orderSK)
        const orders = mapDBEntriesToOutput(data.Items)

        if (orders.length < 1) {
            const response = {
                statusCode: 404,
                headers: makeHeader('application/json'),
                body: JSON.stringify({message: `No order for ${customer} with this id found`}),
            };
            callback(null, response);
            return;
        }

        const response = {
            statusCode: 200,
            headers: makeHeader('application/json'),
            body: JSON.stringify(orders[0])
        };
        callback(null, response);
    } catch(err) {
        console.error('Query failed to load data. Error JSON: ', JSON.stringify(err, null, 2));
        const response = {
            statusCode: err.statusCode || 501,
            headers: makeHeader('text/plain'),
            body: 'Failed to fetch this order because of ' + err,
        };
        callback(null, response);
    }
};

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
        await replyWithUserOrders(brand, cognitoUserName, defaultPerPage, callback)
    } else {
        await replyWithAllOrders(brand, cognitoUserName, defaultPerPage, callback)
    }
};

// Get all orders for the current user or a specified third user depending on the accessLvl
exports.allPaginated = async (event, context, callback) => {
    if (event.queryStringParameters.brand == undefined) {
        callback(null, {
            statusCode: 403,
            headers: makeHeader('text/plain'),
            body: `Missing query parameter 'brand'`,
        });
    }

    const brand = event.queryStringParameters.brand;

    var perPage = event.queryStringParameters.perPage;
    if (!perPage || perPage > 2 * defaultPerPage) {
        perPage = 2 * defaultPerPage
    }

    const cognitoUserName = event.requestContext.authorizer.claims["cognito:username"].toLowerCase();

    const askingForStoreOnly = event.queryStringParameters.store && event.queryStringParameters.store === "true"

    if (askingForStoreOnly) {
        await replyWithUserOrders(brand, cognitoUserName, perPage, callback, true)
    } else {
        await replyWithAllOrders(brand, cognitoUserName, perPage, callback, true)
    }
};

async function replyWithUserOrders(brand, cognitoUserName, perPage, callback, shouldPaginate = false) {
    try {
        const data = await loadUserOrdersFromDB(brand, cognitoUserName);
        const LastEvaluatedKey = data.LastEvaluatedKey
        console.log("LastEvaluatedKey: ", LastEvaluatedKey)
        const orders = mapDBEntriesToOutput(data.Items, perPage)
        const body = shouldPaginate? JSON.stringify(paginate(orders, perPage, LastEvaluatedKey)) : JSON.stringify(orders)

        const response = {
            statusCode: 200,
            headers: makeHeader('application/json'),
            body: body
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

async function replyWithAllOrders(brand, cognitoUserName, perPage, callback, shouldPaginate = false) {
    try {
        const accessLvlPromise = getAccessLvl(cognitoUserName, brand)
        const dataPromise = loadAllOrdersFromDB(brand, perPage)

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
        const LastEvaluatedKey = data.LastEvaluatedKey
        console.log("LastEvaluatedKey: ", LastEvaluatedKey)
        const orders = mapDBEntriesToOutput(data.Items)
        const body = shouldPaginate? JSON.stringify(paginate(orders, perPage, LastEvaluatedKey)) : JSON.stringify(orders)

        const response = {
            statusCode: 200,
            headers: makeHeader('application/json'),
            body: body
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

function paginate(orders, perPage, LastEvaluatedKey) {
    if (LastEvaluatedKey) {
        const base64Key = Buffer.from(JSON.stringify(LastEvaluatedKey)).toString('base64')
        return {
            items: orders,
            itemCount: orders.count,
            fullPage: perPage,
            hasMoreContent: LastEvaluatedKey !== undefined,
            nextPageKey: base64Key 
        }
    } else {
        return {
            items: orders,
            itemCount: orders.count,
            fullPage: perPage,
            hasMoreContent: false,
        }
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
