/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const dynamoDb = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();
const { getAccessLvl , accessLvlMayCreate } = require('../shared/access_methods')
const { convertStoredModel } = require('../shared/convert_models')
const { getModels } = require('../shared/get_dyndb_models')
const path = require('path');

function urlPath(urlString) {
    if (!urlString) return undefined
    let url = new URL(urlString)
    let pathName = url.pathname
    return pathName.startsWith("/") ? pathName.substring(1, pathName.length) : pathName
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

async function createModelInDB(user, values, brand, category) {
    const sanitize = (value) => ( value ? value : "placeholder.png" ) 

    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        Item: {
            "id": `${brand}#model`,
            "sk": `${category}#${values.name}`,
            "image": sanitize(values.image),
            "localizedNames": values.localizedNames ? JSON.stringify(values.localizedNames) : "{}",
            "props": values.props ? JSON.stringify(values.props) : "{}",
        }
    };
    if (values.modelFile) { params.Item.modelFile = values.modelFile }
    if (values.dxfFile) { params.Item.dxfFile = values.dxfFile }
    if (values.svgFile) { params.Item.svgFile = values.svgFile }
    if (values.status) { params.Item.status = values.status }
    if (values.usdzFile) { params.Item.usdzFile = values.usdzFile }
    if (values.dxfPart2ColorMap) { params.Item.dxfPart2ColorMap = JSON.stringify(values.dxfPart2ColorMap)}
    params.Item.lastEdited = `${user}#${(new Date()).toISOString()}`

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

async function updateModel(value, fileName, name, brand, category) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        Key: {id: `${brand}#model`, sk: `${category}#${name}` },
        UpdateExpression: `set ${value} = :value`,
        ExpressionAttributeValues: {
            ':value' : fileName,
        },
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

async function getModel(brand, category, id) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "sk, image, modelFile, dxfFile, dxfPart2ColorMap, svgFile, usdzFile, #s, localizedNames, props, lastEdited",
        KeyConditionExpression: "#id = :value and #sk = :searchKey",
        ExpressionAttributeNames:{
            "#id": "id",
            "#sk": "sk",
            "#s": "status"
        },
        ExpressionAttributeValues: {
            ":value": `${brand}#model`,
            ":searchKey": `${category}#${id}`
        },
    };

    return dynamoDb.query(params).promise()
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
        let values = ["modelFile", "dxfFile", "svgFile"];
        await Promise.all(values.map(async value => {
            if (model && model[value]) {
                const modelDownloadURL = await getSignedModelDownloadURL(model[value])
                if (modelDownloadURL) model[value] = modelDownloadURL    
            }    
        }))

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

        if (!brand || !category || !modelName || modelName === "undefined") {
            const msg = "To update the status brand, category and modelName need to be in the path"
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
    else body.modelFile = urlPath(body.modelFile)

    const dxfUploadRequested = body.dxfFile && !body.dxfFile.startsWith("http") ? body.dxfFile : false
    if (dxfUploadRequested) delete body.dxfFile
    else body.dxfFile = urlPath(body.dxfFile)

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

        const existingModelPromise = getModel(brand, category, body.name)

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
            const modelAndVersion = `${body.name}-${now.getTime()}`
            const modelFileName = `${modelAndVersion}.${fileExtension(modelUploadRequested)}`
            const modelKey = `original/${brand}/${category}/${modelFileName}`
            modelURLPromise = getSignedModelUploadURL(modelKey)
        }

        var dxfURLPromise
        if (dxfUploadRequested) {
            const now = new Date()
            const modelAndVersion = `${body.name}-${now.getTime()}`
            const modelFileName = `${modelAndVersion}.${fileExtension(dxfUploadRequested)}`
            const modelKey = `original/${brand}/${category}/${modelFileName}`
            dxfURLPromise = getSignedModelUploadURL(modelKey)
        }

        const existingModelData = await existingModelPromise
        const existingModel = existingModelData.Count > 0 ? existingModelData.Items[0] : undefined
        if (existingModel) {
            // copy the existing models values which shouldn't be overwritten
            if (existingModel.status) body.status = existingModel.status
            if (existingModel.modelFile) body.modelFile = existingModel.modelFile                
            if (!modelUploadRequested) {
                if (existingModel.usdzFile) body.usdzFile = existingModel.usdzFile                
            }
            if (existingModel.dxfFile) body.dxfFile = existingModel.dxfFile
            if (!dxfUploadRequested) {
                if (existingModel.svgFile) body.svgFile = existingModel.svgFile
            }
        } else if (body.svgFile && body.svgFile.startsWith("http")) {
            body.svgFile = urlPath(body.svgFile)
        }

        const writeDBPromise = createModelInDB(cognitoUserName, body, brand, category)

        const imageUploadURL = imageURLPromise ? await imageURLPromise : undefined
        const modelUploadURL = modelURLPromise ? await modelURLPromise : undefined
        const dxfUploadURL = dxfURLPromise ? await dxfURLPromise : undefined
        const writeSuccess = await writeDBPromise
        console.log("write model to db success: ", writeSuccess)

        const response = {
            statusCode: 200,
            headers: makeHeader('application/json' ),
            body: JSON.stringify({
                message: "Model creation or update successful",
                imageUploadURL: imageUploadURL ? imageUploadURL : "",
                modelUploadURL: modelUploadURL ? modelUploadURL : "",
                dxfUploadURL: dxfUploadURL ? dxfUploadURL : ""
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

exports.copy = async (event, context, callback) => {
    const cognitoUserName = event.requestContext.authorizer.claims["cognito:username"].toLowerCase();
    const brand = event.pathParameters.brand.toLowerCase()
    const category = event.pathParameters.category.toLowerCase()
    const id = event.pathParameters.id.toLowerCase()

    var body = JSON.parse(event.body)
    let newBrand = body.brand
    let newCategory = body.category

    try {
        if (!newBrand || !newCategory) {
            callback(null, {
                statusCode: 403,
                headers: makeHeader('application/json' ),
                body: JSON.stringify({ "message": "The body should contain the new Brand and new Category to be copied too." })
            });
            return;
        }

        const accessLvlPromise = getAccessLvl(cognitoUserName, newBrand)
        const existingModelPromise = getModel(brand, category, id)

        // make sure the current cognito user has high enough access lvl
        const accessLvl = await accessLvlPromise;
        if (!accessLvlMayCreate(accessLvl)) {
            const msg = "This user isn't allowed to create or update models"
            callback(null, {
                statusCode: 403,
                headers: makeHeader('application/json' ),
                body: JSON.stringify({ "message": msg })
            });
            return;
        }

        const existingModelData = await existingModelPromise

        const existingModel = existingModelData.Count > 0 ? existingModelData.Items[0] : undefined
        if (!existingModel) {
            callback(null, {
                statusCode: 400,
                headers: makeHeader('application/json'),
                body: JSON.stringify({ "message": `No existing model found in brand ${brand} and category ${category}` })
            });
            return;
        }


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
    try {
        for (const index in event.Records) {
            const record = event.Records[index]
            const key = record.s3.object.key
            const brand = key.split('/')[1]
            const category = key.split('/')[2]
            const parsedPath = path.parse(key)
            const file = parsedPath.base
            const dashSeparated = parsedPath.name.split('-')
            dashSeparated.pop() // pop the timestamp
            const modelId = dashSeparated.join('-')

            console.log(`New encrypted USDZ file ${file} has been created in S3, brand: ${brand}, category: ${category}, modelId: ${modelId}`)
    
            const modelData = await getModel(brand, category, modelId)

            if (!modelData || !modelData.Items || modelData.Items.length == 0) {
                const msg = `Failed to find model with brand: ${brand}, category: ${category}, modelId: ${modelId} in DB`
                console.error(msg)
                callback(null, {msg: msg})
                return
            }

            const model = modelData.Items[0]
            const originalModelFilename = path.parse(model.modelFile).name

            console.log("originalModelFilename: ", originalModelFilename)
            if (originalModelFilename !== parsedPath.name) {
                const msg = `Saved originalModelFilename: ${originalModelFilename} is different then ${file}, not saving`
                console.error(msg)
                callback(null, {msg: msg})
                return
            }

            const updateSuccess = await updateModel("usdzFile", key, modelId, brand, category)
            console.log("Updating usdzFile to ", key, " in db success: ", updateSuccess)    

            callback(null, {msg: "Success"})
        }
    } catch (error) {
        callback(error, {msg: `Failed to save data because of ${error.toString()}`})
    }
}

// Update the metadata in the DB when a models svg has finished converting
exports.updateModelSVG = async (event, context, callback) => {
    try {
        for (const index in event.Records) {
            const record = event.Records[index]
            const key = record.s3.object.key
            const brand = key.split('/')[1]
            const category = key.split('/')[2]
            const parsedPath = path.parse(key)
            const file = parsedPath.base
            const dashSeparated = parsedPath.name.split('-')
            dashSeparated.pop() // pop the timestamp
            const modelId = dashSeparated.join('-')

            console.log(`New encrypted svg file ${file} has been created in S3, brand: ${brand}, category: ${category}, modelId: ${modelId}`)
    
            const modelData = await getModel(brand, category, modelId)

            if (!modelData || !modelData.Items || modelData.Items.length == 0) {
                const msg = `Failed to find model with brand: ${brand}, category: ${category}, modelId: ${modelId} in DB`
                console.error(msg)
                callback(null, {msg: msg})
                return
            }

            const model = modelData.Items[0]
            const dxfFilename = path.parse(model.dxfFile).name

            console.log("originalDXFFilename: ", dxfFilename)
            if (dxfFilename !== parsedPath.name) {
                const msg = `Saved originalModelFilename: ${dxfFilename} is different then ${file}, not saving`
                console.error(msg)
                callback(null, {msg: msg})
                return
            }

            const updateSuccess = await updateModel("svgFile", key, modelId, brand, category)
            console.log("Updating svgFile to ", key, " in db success: ", updateSuccess)    

            callback(null, {msg: "Success"})
        }
    } catch (error) {
        callback(error, {msg: `Failed to save data because of ${error.toString()}`})
    }
}

