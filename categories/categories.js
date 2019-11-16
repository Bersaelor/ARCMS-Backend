/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const dynamoDb = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();

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

async function getCategorys(brand) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "sk, image, localizedTitles, localizedDetails",
        KeyConditionExpression: "#id = :value",
        ExpressionAttributeNames:{
            "#id": "id",
        },
        ExpressionAttributeValues: {
            ":value": `${brand}#category`,
        },
    };

    return dynamoDb.query(params).promise()
}

async function getSignedImageUploadURL(key, type) {
    var params = {
        Bucket: process.env.IMAGE_BUCKET,
        Key: key,
        ContentType: type,
        Expires: 600,
        ACL: 'public-read',
    }

    console.log("params: ", params)

    return new Promise(function (resolve, reject) {
        s3.getSignedUrl('putObject', params, function (err, url) { 
            if (err) reject(err)
            else resolve(url); 
        });
    });
}

function convertStoredCategory(storedCategory) {
    var category = storedCategory
    category.name = storedCategory.sk
    delete category.sk
    category.localizedTitles = JSON.parse(storedCategory.localizedTitles)
    category.localizedDetails = JSON.parse(storedCategory.localizedDetails)
    category.image = "https://images.looc.io/" + storedCategory.image
    return category
}

async function createCategoryInDB(values, brand) {
    const sanitize = (value) => ( value ? value : "n.A." ) 

    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        Item: {
            "id": `${brand}#category`,
            "sk": values.name,
            "image": sanitize(values.image),
            "localizedTitles": values.localizedTitles ? JSON.stringify(values.localizedTitles) : "n.A.",
            "localizedDetails": values.localizedDetails ? JSON.stringify(values.localizedDetails) : "n.A."
        }
    };

    return dynamoDb.put(params).promise();
}

function accessLvlMayCreate(accessLvl) {
    return accessLvl == process.env.ACCESS_ADMIN || accessLvl == process.env.ACCESS_MANAGER;
}

function makeHeader(content) {
    return { 
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true,
        'Cache-Control': 'max-age=10,must-revalidate',
        'Content-Type': content
    };
}

const fileExtension = (filename) => {
    return filename.split('.').pop();
}

// Cached, public collections endpoint
exports.all = async (event, context, callback) => {
    const brand = event.pathParameters.brand.toLowerCase()

    const data = await getCategorys(brand)

    const categories = data.Items.map((cat) => {
        return convertStoredCategory(cat)
    })

    callback(null, {
        statusCode: 200,
        headers: makeHeader('text/plain'),
        body: JSON.stringify(categories)
    });
};

exports.createNew = async (event, context, callback) => {
    const cognitoUserName = event.requestContext.authorizer.claims["cognito:username"].toLowerCase();
    const brand = event.pathParameters.brand.toLowerCase()
    var body = JSON.parse(event.body)

    const imageUploadRequested = body.imageName
    const imageType = body.imageType
    delete body.imageType
    delete body.imageName

    try {
        const accessLvlPromise = getAccessLvl(cognitoUserName, brand)

        if (!body.name) {
            callback(null, {
                statusCode: 403,
                headers: makeHeader('application/json' ),
                body: JSON.stringify({ "message": "The new category needs to have a valid name" })
            });
            return;
        }
        body.name = body.name.toLowerCase()

        // make sure the current cognito user has high enough access lvl
        const accessLvl = await accessLvlPromise;
        if (!accessLvl || !accessLvlMayCreate(accessLvl)) {
            const msg = "This user isn't allowed to create or update categories"
            callback(null, {
                statusCode: 403,
                headers: makeHeader('application/json' ),
                body: JSON.stringify({ "message": msg })
            });
            return;
        }

        var imageURLPromise
        if (imageUploadRequested) {
            const now = new Date()
            const imageFileFolder = `${body.name}-${now.getTime()}`
            const imageFileName = `${imageFileFolder}.${fileExtension(imageUploadRequested)}`
            const imageKey = `${imageFileFolder}/${imageFileName}`
            body.image = imageKey
            imageURLPromise = getSignedImageUploadURL(imageKey, imageType)
        }

        const writeDBPromise = createCategoryInDB(body, brand)

        const imageUploadURL = imageURLPromise ? await imageURLPromise : undefined
        const writeSuccess = await writeDBPromise
        console.log("write Category to db success: ", writeSuccess)

        console.log("imageUploadURL: ", imageUploadURL)

        const response = {
            statusCode: 200,
            headers: makeHeader('application/json' ),
            body: JSON.stringify({
                "message": "Category creation or update successful",
                "uploadURL": imageUploadURL ? imageUploadURL : ""
            })
        };
    
        callback(null, response);

    } catch(error) {
        console.error('Failed to category user: ', JSON.stringify(error, null, 2));
        callback(null, {
            statusCode: error.statusCode || 501,
            headers: makeHeader('text/plain'),
            body: `Encountered error ${error}`,
        });
        return;
    }
};