/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const dynamoDb = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();
const { getAccessLvl , accessLvlMayCreate} = require('../shared/access_methods')

async function getModels(brand, category) {
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

    return new Promise(function (resolve, reject) {
        s3.getSignedUrl('putObject', params, function (err, url) { 
            if (err) reject(err)
            else resolve(url); 
        });
    });
}

function convertStoredModel(storedModel) {
    var category = storedModel
    category.name = storedModel.sk
    delete category.sk
    category.localizedTitles = JSON.parse(storedModel.localizedTitles)
    category.localizedDetails = JSON.parse(storedModel.localizedDetails)
    category.image = "https://images.looc.io/" + storedModel.image
    return category
}

async function createModelInDB(values, brand, category) {
    const sanitize = (value) => ( value ? value : "placeholder.png" ) 

    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        Item: {
            "id": `${brand}#model`,
            "sk": `${category}#${values.name}`,
            "image": sanitize(values.image),
            "localizedTitles": values.localizedTitles ? JSON.stringify(values.localizedTitles) : "n.A.",
            "localizedDetails": values.localizedDetails ? JSON.stringify(values.localizedDetails) : "n.A."
        }
    };

    return dynamoDb.put(params).promise();
}

async function deleteModelFromDB(name, brand, category) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        Key: {
            "id": `${brand}#model`,
            "sk": `${category}#${name}`
        } 
    };

    return dynamoDb.delete(params).promise()
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
    const category = event.pathParameters.category.toLowerCase()

    const data = await getModels(brand, category)

    const categories = data.Items.map((cat) => {
        return convertStoredModel(cat)
    })

    console.log("Returning ", categories.length, " models from DynDB")

    callback(null, {
        statusCode: 200,
        headers: makeHeader('text/plain'),
        body: JSON.stringify(categories)
    });
};

exports.createNew = async (event, context, callback) => {
    const cognitoUserName = event.requestContext.authorizer.claims["cognito:username"].toLowerCase();
    const brand = event.pathParameters.brand.toLowerCase()
    const category = event.pathParameters.category.toLowerCase()

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
        } else if (body.image && body.image.startsWith("http")) {
            // remove the host from as we store only the image key in the db
            var url = new URL(body.image)
            var path = url.pathname
            if (path.startsWith("/")) path = path.slice(1)
            body.image = path
        }

        const writeDBPromise = createModelInDB(body, brand, category)

        const imageUploadURL = imageURLPromise ? await imageURLPromise : undefined
        const writeSuccess = await writeDBPromise
        console.log("write model to db success: ", writeSuccess)

        const response = {
            statusCode: 200,
            headers: makeHeader('application/json' ),
            body: JSON.stringify({
                "message": "Model creation or update successful",
                "uploadURL": imageUploadURL ? imageUploadURL : ""
            })
        };
    
        callback(null, response);

    } catch(error) {
        console.error('Failed to create model: ', JSON.stringify(error, null, 2));
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
    const brand = event.pathParameters.brand.toLowerCase()
    const id = event.pathParameters.id.toLowerCase()
    const category = event.pathParameters.category.toLowerCase()

    if (!id || !brand || !category) {
        callback(null, {
            statusCode: 403,
            headers: makeHeader('text/plain'),
            body: `Expected both a brand, modelname and a category, one is missing.`,
        });
        return;
    }

    console.log(cognitoUserName, " wants to delete model named: ", id, " from brand ", brand)
    try {
        // make sure the current cognito user has high enough access lvl
        const accessLvlPromise = getAccessLvl(cognitoUserName, brand);

        const ownAccessLvl = await accessLvlPromise;
        if (!accessLvlMayCreate(ownAccessLvl)) {
            const msg = `User ${cognitoUserName} is not allowed to delete models of ${brand}`
            callback(null, {
                statusCode: 403,
                headers: makeHeader('application/json' ),
                body: JSON.stringify({ "message": msg })
            });
            return;
        }

        const dbDeletionResponse = await deleteModelFromDB(id, brand, category)
        console.log("dbDeletionResponse: ", dbDeletionResponse)

        const response = {
            statusCode: 200,
            headers: makeHeader('application/json'),
            body: JSON.stringify({ "message": "Deletion of model " + id + " successful" })
        };

        callback(null, response);
    } catch (error) {
        console.error('Query failed to delete. Error JSON: ', JSON.stringify(error, null, 2));
        callback(null, {
            statusCode: error.statusCode || 501,
            headers: makeHeader('text/plain'),
            body: `Encountered error ${error}`,
        });
        return;
    }
}