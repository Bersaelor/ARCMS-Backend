/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const dynamoDb = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();
const { getAccessLvl , accessLvlMayCreate } = require('./shared/access_methods')
const path = require('path');

function getS3Content(bucket, prefix, continuationToken) {
    var params = {
        Bucket: bucket,
        Prefix: prefix,
        MaxKeys: 100,
    }

    if (continuationToken) {
        params.ContinuationToken = continuationToken
    }

    return s3.listObjectsV2(params).promise()
}

async function getSignedUploadURL(key) {
    var params = {
        Bucket: process.env.MODEL_BUCKET,
        Key: key,
        StorageClass: "STANDARD_IA",
        Expires: 600,
    }

    return new Promise(function (resolve, reject) {
        s3.getSignedUrl('putObject', params, function (err, url) { 
            if (err) reject(err)
            else resolve(url); 
        });
    });
}

async function getSignedDownloadURL(key) {
    var params = {
        Bucket: process.env.MODEL_BUCKET,
        Key: key,
        Expires: 600,
    }

    return new Promise(function (resolve, reject) {
        s3.getSignedUrl('getObject', params, function (err, url) { 
            if (err) reject(err)
            else resolve(url); 
        });
    });
}

function deleteObject(key) {
    var params = {
        Bucket: process.env.MODEL_BUCKET,
        Key: key
    }
    return s3.deleteObject(params).promise()
}

// Example fileData.Contents dictionary entry:
// ETag: ""8b5f3a00ee6476fadb0bc0f3ccc7f38f""
// Key: "metafiles/loocfun/classic/001panto/IMG_E3ABBBD76582-1.jpeg"
// LastModified: "2021-01-18T21:59:45.000Z"
// Size: 2100629
// StorageClass: "STANDARD"
function convertFile(file, downloadPrefix) {
    var result = {}
    const parsedPath = path.parse(file.Key)
    result.name = parsedPath.base
    result.size = file.Size
    result.lastModified = file.LastModified
    result.downloadURL = path.join(downloadPrefix, parsedPath.name)

    return result
}

function makeHeader(content, location) {
    const headers = { 
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true,
        'Content-Type': content
    };

    if (location) headers.Location = location;

    return headers;
}

// Get an array of files for a given brand, category, model
exports.getList = async (event, context, callback) => {
    let cognitoUserName = event.requestContext.authorizer.claims["cognito:username"].toLowerCase();
    const brand = event.pathParameters.brand.toLowerCase()
    const modelid = event.pathParameters.modelid.toLowerCase()
    const category = event.pathParameters.category.toLowerCase()

    if (!modelid || !brand || !category) {
        callback(null, {
            statusCode: 403,
            headers: makeHeader('text/plain'),
            body: `Expected both a brand, modelname and a category, one is missing.`,
        });
        return;
    }

    console.log(cognitoUserName, " wants to read all files for model named: ", modelid, " from brand ", brand)
    try {
        // make sure the current cognito user has high enough access lvl
        const ownAccessLvl = await getAccessLvl(cognitoUserName, brand);
        if (!accessLvlMayCreate(ownAccessLvl)) {
            const msg = `User ${cognitoUserName} is not allowed to delete models of ${brand}`
            callback(null, {
                statusCode: 403,
                headers: makeHeader('application/json' ),
                body: JSON.stringify({ "message": msg })
            });
            return;
        }

        const prefix = `metafiles/${brand}/${category}/${modelid}`
        const fileData = await getS3Content(process.env.MODEL_BUCKET, prefix, null)
        const downloadPrefix = path.join(process.env.API_HOST_URL, 'metafiles', brand, 'category', category, modelid, 'files')
        const files = Object.values(fileData.Contents).map(file => convertFile(file, downloadPrefix))

        callback(null, {
            statusCode: 200,
            headers: makeHeader('application/json'),
            body: JSON.stringify(files)
        });
    } catch (error) {
        console.error('Query failed to fetch files. Error JSON: ', JSON.stringify(error, null, 2));
        callback(null, {
            statusCode: error.statusCode || 501,
            headers: makeHeader('text/plain'),
            body: `Encountered error ${error}`,
        });
        return;
    }
};

// Get an upload url for uploading a new file
exports.getUploadURL = async (event, context, callback) => {
    let cognitoUserName = event.requestContext.authorizer.claims["cognito:username"].toLowerCase();
    const brand = event.pathParameters.brand.toLowerCase()
    const modelid = event.pathParameters.modelid.toLowerCase()
    const category = event.pathParameters.category.toLowerCase()
    const fileName = event.queryStringParameters && event.queryStringParameters.fileName && decodeURIComponent(event.queryStringParameters.fileName);

    if (!modelid || !brand || !category || !fileName) {
        callback(null, {
            statusCode: 403,
            headers: makeHeader('text/plain'),
            body: `Expected both a brand, modelname and a category, one is missing.`,
        });
        return;
    }

    console.log(cognitoUserName, " wants to upload file named ", fileName, " for: ", modelid, " from brand ", brand)
    try {
        // make sure the current cognito user has high enough access lvl
        const ownAccessLvl = await getAccessLvl(cognitoUserName, brand);
        if (!accessLvlMayCreate(ownAccessLvl)) {
            const msg = `User ${cognitoUserName} is not allowed to delete models of ${brand}`
            callback(null, {
                statusCode: 403,
                headers: makeHeader('application/json' ),
                body: JSON.stringify({ "message": msg })
            });
            return;
        }

        const fileKey = `metafiles/${brand}/${category}/${modelid}/${fileName}`
        const uploadURL = await getSignedUploadURL(fileKey)

        callback(null, {
            statusCode: 200,
            headers: makeHeader('application/json'),
            body: JSON.stringify({
                message: "Upload URL successfully created",
                uploadURL: uploadURL ? uploadURL : ""
            })
        });
    } catch (error) {
        console.error('Query failed to fetch uploadURL. Error JSON: ', JSON.stringify(error, null, 2));
        callback(null, {
            statusCode: error.statusCode || 501,
            headers: makeHeader('text/plain'),
            body: `Encountered error ${error}`,
        });
        return;
    }
};

// Get a download url for a given file
exports.requestDownloadURL = async (event, context, callback) => {
    let cognitoUserName = event.requestContext.authorizer.claims["cognito:username"].toLowerCase();
    const brand = event.pathParameters.brand.toLowerCase()
    const modelid = event.pathParameters.modelid.toLowerCase()
    const category = event.pathParameters.category.toLowerCase()
    const fileName = event.queryStringParameters && event.queryStringParameters.fileName && decodeURIComponent(event.queryStringParameters.fileName);

    if (!modelid || !brand || !category || !fileName) {
        callback(null, {
            statusCode: 403,
            headers: makeHeader('text/plain'),
            body: `Expected both a brand, modelname and a category, one is missing.`,
        });
        return;
    }

    console.log(cognitoUserName, " wants download file ",  fileName, " for ", modelid, " from brand ", brand)
    try {
        // make sure the current cognito user has high enough access lvl
        const ownAccessLvl = await getAccessLvl(cognitoUserName, brand);
        if (!accessLvlMayCreate(ownAccessLvl)) {
            const msg = `User ${cognitoUserName} is not allowed to delete models of ${brand}`
            callback(null, {
                statusCode: 403,
                headers: makeHeader('application/json' ),
                body: JSON.stringify({ "message": msg })
            });
            return;
        }

        const fileKey = `metafiles/${brand}/${category}/${modelid}/${fileName}`
        const downloadURL = await getSignedDownloadURL(fileKey)

        callback(null, {
            statusCode: 200,
            headers: makeHeader('application/json'),
            body: JSON.stringify({
                message: "Download URL successfully created",
                downloadURL: downloadURL ? downloadURL : ""
            })
        });
    } catch (error) {
        console.error('Query failed to fetch downloadurl. Error JSON: ', JSON.stringify(error, null, 2));
        callback(null, {
            statusCode: error.statusCode || 501,
            headers: makeHeader('text/plain'),
            body: `Encountered error ${error}`,
        });
        return;
    }
};

// Request a specific file to be deleted
exports.requestFileDeletion = async (event, context, callback) => {
    let cognitoUserName = event.requestContext.authorizer.claims["cognito:username"].toLowerCase();
    const brand = event.pathParameters.brand.toLowerCase()
    const modelid = event.pathParameters.modelid.toLowerCase()
    const category = event.pathParameters.category.toLowerCase()
    const fileName = event.queryStringParameters && event.queryStringParameters.fileName && decodeURIComponent(event.queryStringParameters.fileName);

    if (!modelid || !brand || !category || !fileName) {
        callback(null, {
            statusCode: 403,
            headers: makeHeader('text/plain'),
            body: `Expected both a brand, modelname and a category, one is missing.`,
        });
        return;
    }

    console.log(cognitoUserName, " wants to delete file ",  fileName, " for ", modelid, " from brand ", brand)
    try {
        // make sure the current cognito user has high enough access lvl
        const ownAccessLvl = await getAccessLvl(cognitoUserName, brand);
        if (!accessLvlMayCreate(ownAccessLvl)) {
            const msg = `User ${cognitoUserName} is not allowed to delete models of ${brand}`
            callback(null, {
                statusCode: 403,
                headers: makeHeader('application/json' ),
                body: JSON.stringify({ "message": msg })
            });
            return;
        }

        const fileKey = `metafiles/${brand}/${category}/${modelid}/${fileName}`
        const deletionResponse = await deleteObject(fileKey)
        console.log("deletionResponse: ", deletionResponse)

        callback(null, {
            statusCode: 200,
            headers: makeHeader('application/json'),
            body: JSON.stringify({
                message: `Deleting ${fileName} was succesful`
            })
        });
    } catch (error) {
        console.error('Query failed to delete file. Error JSON: ', JSON.stringify(error, null, 2));
        callback(null, {
            statusCode: error.statusCode || 501,
            headers: makeHeader('text/plain'),
            body: `Encountered error ${error}`,
        });
        return;
    }
};