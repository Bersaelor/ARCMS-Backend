/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const dynamoDb = new AWS.DynamoDB.DocumentClient();
var cognitoProvider = new AWS.CognitoIdentityServiceProvider({apiVersion: '2016-04-18'});

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
                reject(error);
                return;
            } else if (data.Items == undefined || data.Items.length < 1) {
                reject('No user named "' + cognitoUserName + '" for brand \'' + brand + '\' !');
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

async function getIsDBUserExisting(email, brand) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "accessLvl",
        KeyConditionExpression: "#id = :value and sk = :brand",
        ExpressionAttributeNames:{
            "#id": "id"
        },
        ExpressionAttributeValues: {
            ":value": email,
            ":brand": `${brand}#user`
        }
    };

    return new Promise((resolve, reject) => {
        dynamoDb.query(params, (error, data) => {
            if (error) {
                reject(error);
                return;
            } else if (data.Count || data.Items.length < 1) {
                console.log(`So far no user named "${email}" exists for ${brand}". Thats good.`);
                resolve(false);
                return;
            } else if (data.Items.length > 0 ) {
                console.log('Found existing user with email ', email);
                resolve(true);
                return;
            } else {
                reject("Unexpected result: ", data);
            }
        });
    });
}

function accessLvlMayCreateUsers(accessLvl) {
    return accessLvl == process.env.ACCESS_ADMIN || accessLvl == process.env.ACCESS_MANAGER;
}

function makeHeader(content) {
    return { 
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true,
        'Content-Type': content
    };
}

async function createUserInDB(values) {
    const sanitize = (value) => ( value ? value : "n.A." ) 

    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "sk, accessLvl",
        Item: {
            "id": values.email.toLowerCase(),
            "sk": `${values.brand}#user`,
            "accessLvl": values.accessLvl,
            "firstName": sanitize(values.firstName),
            "lastName": sanitize(values.lastName),
            "company": sanitize(values.company),
            "address": sanitize(values.address),
            "zipCode": sanitize(values.zipCode),
            "city": sanitize(values.city),
            "telNr": sanitize(values.telNr),
            "maxDevices": values.maxDevices
        }
    };

    return dynamoDb.put(params).promise();
}

async function getBrands(cognitoName) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "sk, accessLvl",
        KeyConditionExpression: "#id = :value",
        ExpressionAttributeNames:{
            "#id": "id"
        },
        ExpressionAttributeValues: {
            ":value": cognitoName
        }
    };

    return dynamoDb.query(params).promise()
}

async function deleteUserFromDB(email, brand) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        Key: {
            "id": email,
            "sk": `${brand}#user`,
        } 
    };

    return dynamoDb.delete(params).promise()
}

async function getDevices(email, brand) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "sk",
        KeyConditionExpression: "#id = :value and begins_with(sk, :brand)",
        ExpressionAttributeNames:{
            "#id": "id",
        },
        ExpressionAttributeValues: {
            ":value": `${email}#device`,
            ":brand": brand
        }
    };

    return dynamoDb.query(params).promise()
}

async function deleteDevicesFromDB(email, brand) {

    const deviceData = await getDevices(email, brand)
    const devices = deviceData.Items

    var deletePromises = devices.map(device => {
        var params = {
            TableName: process.env.CANDIDATE_TABLE,
            Key: {
                "id": `${email}#device`,
                "sk": device.sk,
            } 
        };
    
        return dynamoDb.delete(params).promise()
    })

    return Promise.all(deletePromises)
}

async function getIsCognitoUserExisting(email) {
    var params = {
        UserPoolId: 'eu-central-1_Qg8GXUJ2v', 
        Username: email,
    };
    return new Promise((resolve, reject) => {
        cognitoProvider.adminGetUser(params, (error, data) => {
            if (error && error.code === "UserNotFoundException") {
                resolve(false)
                return
            } else if (error) {
                reject(error)
                return
            } else if (data && data.Username) {
                console.log('Found existing user with email ', data.Username);
                resolve(true);
                return;
            } else {
                reject("Unexpected result: ", data);
            }
        });
    });
}

async function createCognitoUser(email, firstName, lastName) {
    var params = {
        UserPoolId: 'eu-central-1_Qg8GXUJ2v', /* required */
        Username: email, /* required */
        DesiredDeliveryMediums: [ 'EMAIL' ],
        ForceAliasCreation: false,
        UserAttributes: [
            {
                Name: 'email', /* required */
                Value: email
            }
        ]
    };
    return cognitoProvider.adminCreateUser(params).promise();
}

async function setEmailVerified(email) {
    var params = {
        UserPoolId: 'eu-central-1_Qg8GXUJ2v', /* required */
        Username: email, /* required */
        UserAttributes: [{ Name: "email_verified", Value: "true"}]
    };

    return cognitoProvider.adminUpdateUserAttributes(params).promise();
}

async function deleteUserFromCognito(cognitoName) {
    var params = {
        UserPoolId: 'eu-central-1_Qg8GXUJ2v', 
        Username: cognitoName,
    };
    return cognitoProvider.adminDeleteUser(params).promise();
}

exports.createNew = async (event, context, callback) => {

    let cognitoUserName = event.requestContext.authorizer.claims["cognito:username"].toLowerCase();
    let body = JSON.parse(event.body)
    let brand = body.brand;
    let accessLvl = body.accessLvl;
    let email = body.email.toLowerCase()

    console.log("event.body: ", body);
    console.log("cognitoUserName: ", cognitoUserName, " brand: ", brand);

    try {
        // TODO: Proper error messages for all kinds of missing body values

        console.log("Checking whether current user is allowed to create user with accessLvl: ", accessLvl)
        if (!accessLvl || (accessLvl !== process.env.ACCESS_STORE && accessLvl !== process.env.ACCESS_MANAGER)) {
            console.log(`Access lvl is neither ${process.env.ACCESS_STORE} nor ${process.env.ACCESS_MANAGER}`)
            callback(null, {
                statusCode: 403,
                headers: makeHeader('text/plain'),
                body: `New Users need to have a valid access lvl of "${process.env.ACCESS_STORE}" or "${process.env.ACCESS_MANAGER}"`,
            });
            return;
        }

        // make sure the current cognito user has high enough access lvl
        const accessLvlPromise = getAccessLvl(cognitoUserName, brand);

        // check whether a user with that name already exists
        const isDBUserExistingPromise = getIsDBUserExisting(email, brand)

        // check whether a new cognito user has to be created
        const isCognitoUserExistingPromise = getIsCognitoUserExisting(email)

        const ownAccessLvl = await accessLvlPromise;
        if (!accessLvlMayCreateUsers(ownAccessLvl)) {
            callback(null, {
                statusCode: 403,
                headers: makeHeader('text/plain'),
                body: `User ${cognitoUserName} is not allowed to delete users for ${brand}`,
            });
            return;
        }

        const isUserExisting = await isDBUserExistingPromise;
        if (isUserExisting) {
            callback(null, {
                statusCode: 403,
                headers: makeHeader('text/plain'),
                body: `User ${email} already exists for ${brand}`,
            });
            return;
        }

        const writeDBPromise = createUserInDB(body)

        const isCognitoUserExisting = await isCognitoUserExistingPromise;

        var createCognitoPromise = null
        if (!isCognitoUserExisting) {
            createCognitoPromise = createCognitoUser(email, body.firstName, body.lastName)
        } else {
            console.log("User already exists in Cognito, no need to create again")
        }

        const createUserSuccess = (createCognitoPromise) ? await createCognitoPromise : "not needed"
        console.log("createUserSuccess: ", createUserSuccess)
        var verifyEmailPromise = !isCognitoUserExisting ? setEmailVerified(email) : null

        const writeSuccess = await writeDBPromise
        console.log("write User to db success: ", writeSuccess)

        const verifyEmailResult = (verifyEmailPromise) ? await verifyEmailPromise : "not needed"
        console.log("verifyEmailResult: ", verifyEmailResult)

        const response = {
            statusCode: 200,
            headers: makeHeader('application/json' ),
            body: JSON.stringify({"message: ": "User creation successful"})
        };
    
        callback(null, response);

    } catch(error) {
        console.error('Failed to create user: ', JSON.stringify(error, null, 2));
        callback(null, {
            statusCode: error.statusCode || 501,
            headers: makeHeader('text/plain'),
            body: `Encountered error ${error}`,
        });
        return;
    }
};

exports.delete = async (event, context, callback) => {

    let cognitoUserName = event.requestContext.authorizer.claims["cognito:username"].toLowerCase();
    let id = event.pathParameters.id.toLowerCase()
    let brand = event.queryStringParameters.brand;

    if (!id || !brand) {
        callback(null, {
            statusCode: 403,
            headers: makeHeader('text/plain'),
            body: `Expected both a brand and a user-id, one is missing.`,
        });
        return;
    }

    console.log(cognitoUserName, " wants to delete user id: ", id, " from brand ", brand)
    try {
        // get the brands and access level for the user to be deleted
        let brandsOfIdPromise = getBrands(id)
        // make sure the current cognito user has high enough access lvl
        const accessLvlPromise = getAccessLvl(cognitoUserName, brand);

        const ownAccessLvl = await accessLvlPromise;
        if (!accessLvlMayCreateUsers(ownAccessLvl)) {
            callback(null, {
                statusCode: 403,
                headers: makeHeader('text/plain'),
                body: `User ${cognitoUserName} is not allowed to delete users of ${brand}`,
            });
            return;
        }
        
        const data = await getBrands(id)
        let brands = data.Items.map((v) => v.sk.slice(0, -5))
        console.log(id, " is member of ", brands, " brands.")
        let deletableUserAccessLvl = data.Items.find(value => value.sk.slice(0, -5) === brand).accessLvl
        console.log(`In brand "${brand}" this user is a ${deletableUserAccessLvl}.`)
   
        if (deletableUserAccessLvl === process.env.ACCESS_ADMIN) {
            callback(null, {
                statusCode: 403,
                headers: makeHeader('text/plain'),
                body: `Deleting of admins is only allowed via AWS console.`,
            });
            return;
        }

        let dbDeletionPromise = deleteUserFromDB(id, brand)
        let deviceDeletionPromise = deleteDevicesFromDB(id, brand)
        let cognitoDeletionPromise = undefined
        if (brands.length == 1 && brands[0] == brand) {
            cognitoDeletionPromise = deleteUserFromCognito(id)
        } else {
            console.log(`user ${id} is member of ${brands.length} brands, so not deleting from cognito`)
        }

        let devices = await getDevices(id, brand)
        console.log("devices: ", devices)

        const userDeletionResponse = await dbDeletionPromise
        console.log("userDeletionResponse: ", userDeletionResponse)
        const deviceDeletionResponse = await dbDeletionPromise
        console.log("deviceDeletionResponse: ", deviceDeletionResponse)

        if (cognitoDeletionPromise) {
            const cognitoDeletionResponse = await cognitoDeletionPromise
            console.log("cognitoDeletionResponse: ", cognitoDeletionResponse)
        }

        const response = {
            statusCode: 200,
            headers: makeHeader('application/json'),
            body: JSON.stringify({ "message: ": "Deletion of user " + id + " successful" })
        };

        callback(null, response);
    } catch (error) {
        console.error('Query failed to load data. Error JSON: ', JSON.stringify(error, null, 2));
        callback(null, {
            statusCode: error.statusCode || 501,
            headers: makeHeader('text/plain'),
            body: `Encountered error ${error}`,
        });
        return;
    }
}
