/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const dynamoDb = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();
const { getAccessLvl , accessLvlMayCreate } = require('../shared/access_methods')

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

async function getSignedModelUploadURL(key) {
    var params = {
        Bucket: process.env.MODEL_BUCKET,
        Key: key,
        Expires: 600,
    }

    return new Promise(function (resolve, reject) {
        s3.getSignedUrl('putObject', params, function (err, url) { 
            if (err) reject(err)
            else resolve(url); 
        });
    });
}

async function getSignedModelDownloadURL(key) {
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

async function createModelInDB(values, brand, category) {
    const sanitize = (value) => ( value ? value : "placeholder.png" ) 

    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        Item: {
            "id": `${brand}#model`,
            "sk": `${category}#${values.name}`,
            "image": sanitize(values.image),
            "modelFile": values.modelFile ? values.modelFile : "",
            "localizedNames": values.localizedNames ? JSON.stringify(values.localizedNames) : "{}",
            "props": values.props ? JSON.stringify(values.props) : "{}"
        }
    };

    return dynamoDb.put(params).promise();
}

async function updateModelStatus(status, name, brand, category) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        Key: {id: `${brand}#model`, sk: `${category}#${name}` },
        UpdateExpression: 'set #s = :value',
        ExpressionAttributeNames: {'#s' : 'status'},
        ExpressionAttributeValues: {
            ':value' : status,
        },
        ReturnValues: "ALL_NEW"
    };

    return dynamoDb.update(params).promise()
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

async function getModels(brand, category) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "sk, image, modelFile, localizedNames, props",
        KeyConditionExpression: "#id = :value and begins_with(sk, :category)",
        ExpressionAttributeNames:{
            "#id": "id",
        },
        ExpressionAttributeValues: {
            ":value": `${brand}#model`,
            ":category": category
        },
    };

    return dynamoDb.query(params).promise()
}

async function getModel(brand, category, id) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "sk, image, modelFile, localizedNames, props",
        KeyConditionExpression: "#id = :value and #sk = :searchKey",
        ExpressionAttributeNames:{
            "#id": "id",
            "#sk": "sk",
        },
        ExpressionAttributeValues: {
            ":value": `${brand}#model`,
            ":searchKey": `${category}#${id}`
        },
    };

    return dynamoDb.query(params).promise()
}

function convertStoredModel(storedModel) {
    var model = storedModel
    model.category = storedModel.sk.split('#')[0]
    model.name = storedModel.sk.split('#')[1]
    delete model.sk
    try {
        model.localizedNames = storedModel.localizedNames ? JSON.parse(storedModel.localizedNames) : undefined
        model.props = storedModel.props ? JSON.parse(storedModel.props) : undefined    
    } catch (error) {
        console.log("Failed to convert json because: ", error)
    }
    model.image = "https://images.looc.io/" + storedModel.image
    return model
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

    const models = data.Items.map((cat) => {
        return convertStoredModel(cat)
    })

    console.log("Returning ", models.length, " models from DynDB")

    callback(null, {
        statusCode: 200,
        headers: makeHeader('text/plain'),
        body: JSON.stringify(models)
    });
};

exports.get = async (event, context, callback) => {
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

    console.log(cognitoUserName, " wants to read model named: ", id, " from brand ", brand)
    try {
        // make sure the current cognito user has high enough access lvl
        const accessLvlPromise = getAccessLvl(cognitoUserName, brand);
        const dbLoadPromise = getModel(brand, category, id)

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

        const dbLoadData = await dbLoadPromise
        const model = dbLoadData.Count > 0 ? convertStoredModel(dbLoadData.Items[0]) : undefined
        if (model && model.modelFile) {
            const modelDownloadURL = await getSignedModelDownloadURL("original/" + model.modelFile)
            if (modelDownloadURL) model.modelFile = modelDownloadURL    
        }

        var response
        if (model) {
            response = {
                statusCode: 200,
                headers: makeHeader('application/json'),
                body: JSON.stringify(model)
            };
        } else {
            response = {
                statusCode: 404,
                headers: makeHeader('application/json'),
                body: JSON.stringify({ message: `No model found with id ${id} for brand ${brand}` })
            };
        }

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
};

exports.setStatus = async (event, context, callback) => {
    const cognitoUserName = event.requestContext.authorizer.claims["cognito:username"].toLowerCase();
    const brand = event.pathParameters.brand.toLowerCase()
    const category = event.pathParameters.category.toLowerCase()
    const modelName = event.pathParameters.id.toLowerCase()

    var body = JSON.parse(event.body)

    try {
        const accessLvlPromise = getAccessLvl(cognitoUserName, brand)

        if (!body.status || (body.status !== "unpublished" && body.status !== "testing" && body.status !== "published")) {
            callback(null, {
                statusCode: 403,
                headers: makeHeader('application/json' ),
                body: JSON.stringify({ "message": "The new status should be valid" })
            });
            return;
        }
        const status = body.status

        // make sure the current cognito user has high enough access lvl
        const accessLvl = await accessLvlPromise;
        if (!accessLvlMayCreate(accessLvl)) {
            const msg = "This user isn't allowed to create or update categories"
            callback(null, {
                statusCode: 403,
                headers: makeHeader('application/json' ),
                body: JSON.stringify({ "message": msg })
            });
            return;
        }

        const updateSuccess = await updateModelStatus(status, modelName, brand, category)
        console.log("Set status ", status ," of model ", modelName ," in db success: ", updateSuccess)
        const model = convertStoredModel(updateSuccess.Attributes)

        const response = {
            statusCode: 200,
            headers: makeHeader('application/json' ),
            body: JSON.stringify({
                "message": "Model status update successful",
                "item": model
            })
        };
    
        callback(null, response);
    } catch(error) {
        console.error('Failed to update model: ', JSON.stringify(error, null, 2));
        callback(error, {
            statusCode: error.statusCode || 501,
            headers: makeHeader('text/plain'),
            body: `Encountered error ${error}`,
        });
        return;
    }
}

exports.createNew = async (event, context, callback) => {
    const cognitoUserName = event.requestContext.authorizer.claims["cognito:username"].toLowerCase();
    const brand = event.pathParameters.brand.toLowerCase()
    const category = event.pathParameters.category.toLowerCase()

    var body = JSON.parse(event.body)

    const imageUploadRequested = body.imageName
    const imageType = body.imageType
    delete body.imageType
    delete body.imageName


    const modelUploadRequested = body.modelFile && !body.modelFile.startsWith("http") ? body.modelFile : false
    if (modelUploadRequested) delete body.modelFile

    try {
        const accessLvlPromise = getAccessLvl(cognitoUserName, brand)

        if (!body.name) {
            callback(null, {
                statusCode: 403,
                headers: makeHeader('application/json' ),
                body: JSON.stringify({ "message": "The new model needs to have a valid name" })
            });
            return;
        }
        body.name = body.name.toLowerCase()

        // make sure the current cognito user has high enough access lvl
        const accessLvl = await accessLvlPromise;
        if (!accessLvlMayCreate(accessLvl)) {
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

        var modelURLPromise
        if (modelUploadRequested) {
            const now = new Date()
            const modelKey = `${body.name}-${now.getTime()}`
            const modelFileName = `${modelKey}.${fileExtension(modelUploadRequested)}`
            body.modelFile = modelFileName
            modelURLPromise = getSignedModelUploadURL("original/" + modelFileName)
        } else if (body.modelFile && body.modelFile.startsWith("http")) {
            // remove the host and folder as we store only the fileName in the db
            const pathname = (new URL(body.modelFile)).pathname
            var fileName = pathname.substring(pathname.lastIndexOf('/')+1);
            body.modelFile = fileName
        }

        const writeDBPromise = createModelInDB(body, brand, category)

        const imageUploadURL = imageURLPromise ? await imageURLPromise : undefined
        const modelUploadURL = modelURLPromise ? await modelURLPromise : undefined
        const writeSuccess = await writeDBPromise
        console.log("write model to db success: ", writeSuccess)

        const response = {
            statusCode: 200,
            headers: makeHeader('application/json' ),
            body: JSON.stringify({
                message: "Model creation or update successful",
                imageUploadURL: imageUploadURL ? imageUploadURL : "",
                modelUploadURL: modelUploadURL ? modelUploadURL : ""
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

// Update the metadata in the DB when a model file has finished converting
exports.updateAfterFileConversion = async (event, context, callback) => {
    for (const index in event.Records) {
        const record = event.Records[index]
        const bucket = record.s3.bucket.name
        const key = record.s3.object.key
        const parsedPath = path.parse(key)
        const fileName = parsedPath.name

        console.log("New USDZ file ", fileName, " has been created in S3")

        callback(null, {msg: "Success"})
    }
}
