/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const dynamoDb = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();
const cloudfront = new AWS.CloudFront;
const { getAccessLvl , accessLvlMayCreate} = require('../shared/access_methods')
const { convertStoredModel, convertStoredMaterial } = require('../shared/convert_models')
const { getModels, getAllModels, getCategorys } = require('../shared/get_dyndb_models')
const { getMaterials } = require('shared/get_materials')

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

async function getAllMaterials(brand) {
    var LastEvaluatedKey
    var defaultPerPage = 100
    var result = []
    do {
        const data = await getMaterials(brand, undefined, undefined, defaultPerPage, LastEvaluatedKey)
        LastEvaluatedKey = data.LastEvaluatedKey
        const materials = data.Items.map(mat => convertStoredMaterial(mat))
        result = result.concat(materials)
    } while (LastEvaluatedKey !== undefined)
    return result
}

function convertStoredCategory(storedCategory) {
    var category = storedCategory
    category.name = storedCategory.sk
    delete category.sk
    category.localizedTitles = JSON.parse(storedCategory.localizedTitles)
    category.localizedDetails = JSON.parse(storedCategory.localizedDetails)
    category.image = "https://images.looc.io/" + storedCategory.image
    category.promoted = storedCategory.promoted !== undefined ? storedCategory.promoted : false
    return category
}

async function createCategoryInDB(values, brand) {
    const sanitize = (value) => ( value ? value : "placeholder.png" ) 

    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        Item: {
            "id": `${brand}#category`,
            "sk": values.name,
            "image": sanitize(values.image),
            "status": values.status ? values.status : "unpublished",
            "localizedTitles": values.localizedTitles ? JSON.stringify(values.localizedTitles) : "n.A.",
            "localizedDetails": values.localizedDetails ? JSON.stringify(values.localizedDetails) : "n.A."
        }
    };

    return dynamoDb.put(params).promise();
}

async function updateCategoryStatus(status, name, brand) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        Key: {id: `${brand}#category`, sk: name },
        UpdateExpression: 'set #s = :value',
        ExpressionAttributeNames: {'#s' : 'status'},
        ExpressionAttributeValues: {
            ':value' : status,
        },
        ReturnValues: "ALL_NEW"
    };

    return dynamoDb.update(params).promise()
}

async function updateCategoryPromoted(promoted, name, brand) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        Key: {id: `${brand}#category`, sk: name },
        UpdateExpression: 'set #p = :value',
        ExpressionAttributeNames: {'#p' : 'promoted'},
        ExpressionAttributeValues: {
            ':value' : promoted,
        },
        ReturnValues: "ALL_NEW"
    };

    return dynamoDb.update(params).promise()
}

async function deleteCategoryFromDB(name, brand) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        Key: {
            "id": `${brand}#category`,
            "sk": name
        } 
    };

    return dynamoDb.delete(params).promise()
}

async function invalidateAppDataCache(brand) {
    return new Promise((resolve, reject) => {
        const now = new Date()
        const params = { 
            DistributionId: "E2B3LFAX7VM8JV",
            InvalidationBatch: {
                CallerReference: `${now.getTime()}`,
                Paths: {
                  Quantity: '2',
                  Items: [
                    `/${brand}/app-data`,
                    `/${brand}/appconfig`
                  ]
                }
            }
        }
        cloudfront.createInvalidation(params, (err, data) => {
            if (err) reject(err)
            else resolve(data)
        })
    });
}

function makeHeader(content, maxAge = 60) {
    return { 
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true,
        'Cache-Control': `max-age=${maxAge},must-revalidate`,
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

    console.log("Returning ", categories.length, " categories from DynDB for brand ", brand)

    callback(null, {
        statusCode: 200,
        headers: makeHeader('application/json', 0),
        body: JSON.stringify(categories)
    });
};

// Cached, public endpoint with categories and models
exports.appData = async (event, context, callback) => {
    const brand = event.pathParameters.brand.toLowerCase()
    const testing = event.queryStringParameters && event.queryStringParameters.testing;
    const categoryId = event.queryStringParameters && event.queryStringParameters.c;
    const modelId = event.queryStringParameters && event.queryStringParameters.f; // frame, as `m` is used for metal
    const justOneModel = (modelId !== undefined && modelId !== null && categoryId !== undefined && categoryId !== null)
    const showTestingContent = testing && testing === "true"

    try {
        const catPromise = justOneModel ? undefined : getCategorys(brand)
        const modelPromise = brand && (justOneModel ? getModels(brand, categoryId, modelId) : getAllModels(brand))
        const data = await Promise.all([catPromise, modelPromise, getAllMaterials(brand)])
        const catData = data[0]
        const modelData = data[1]
        const materials = data[2].filter(mat => mat.status === "published" || (showTestingContent && mat.status === "testing"))

        const categories = catData && catData.Items.filter(cat => {
            return cat.status === "published" || (showTestingContent && cat.status === "testing")
        }).map((cat) => {
            return convertStoredCategory(cat)
        }) || []

        const categoryNames = categories.map(cat => cat.name)

        var models = modelData.Items.filter(model => {
            return model.status === "published" || (showTestingContent && model.status === "testing")
        }).map(model => {
            return convertStoredModel(model)
        })

        if (!justOneModel) {
            models = models.filter(model => {
                return categoryNames.includes(model.category)
            }).map(model => {
                const category = categories.find(cat => cat.name === model.category)
                const isPromoted = category && category.promoted
                model.promoted = isPromoted
                return model
            })
        }

        console.log(`Returning ${categories.length} categories and ${models.length} models from DynDB for brand ${brand} showTestingContent: ${showTestingContent}`)

        callback(null, {
            statusCode: 200,
            headers: makeHeader('application/json', testing ? 0 : 60 * 60 * 24 * 7),
            body: JSON.stringify({
                categories: categories,
                models: models,
                materials: materials
            })
        });
    } catch (error) {
        console.error(`Query for appData failed. Error ${error}`);
        callback(null, {
            statusCode: error.statusCode || 501,
            headers: makeHeader('text/plain'),
            body: `Encountered error ${error}`,
        });
        return;
    }
};

// Refresh the cached appdata of categories and models manually before it's expired
exports.refreshAppData = async (event, context, callback) => {
    const cognitoUserName = event.requestContext.authorizer.claims["cognito:username"].toLowerCase();
    const brand = event.pathParameters.brand.toLowerCase()

    try {
        // make sure the current cognito user has high enough access lvl
        const accessLvl = await getAccessLvl(cognitoUserName, brand);
        if (!accessLvlMayCreate(accessLvl)) {
            const msg = "This user isn't allowed to create or update categories"
            callback(null, {
                statusCode: 403,
                headers: makeHeader('application/json' ),
                body: JSON.stringify({ "message": msg })
            });
            return;
        }

        const invalidationData = await invalidateAppDataCache(brand)

        console.log("Invalidation of ", brand, " result is: ", invalidationData)

        const response = {
            statusCode: 200,
            headers: makeHeader('application/json' ),
            body: JSON.stringify({
                "message": "AppData Cache refreshing successful" 
            })
        };

        callback(null, response);
    } catch(error) {
        console.error('Failed to create category: ', JSON.stringify(error, null, 2));
        callback(null, {
            statusCode: error.statusCode || 501,
            headers: makeHeader('text/plain'),
            body: `Encountered error ${error}`,
        });
        return;
    }
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
                headers: makeHeader('application/json'),
                body: JSON.stringify({ "message": "The new category needs to have a valid name" })
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

        const updateDBPromise = createCategoryInDB(body, brand)

        const imageUploadURL = imageURLPromise ? await imageURLPromise : undefined
        const updateSuccess = await updateDBPromise
        console.log("write Category to db success: ", updateSuccess)

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
        console.error('Failed to create category: ', JSON.stringify(error, null, 2));
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
    const name = event.pathParameters.category.toLowerCase()
    var body = JSON.parse(event.body)

    try {
        const accessLvlPromise = getAccessLvl(cognitoUserName, brand)

        const hasStatus = body.status && (body.status === "unpublished" || body.status === "testing" || body.status === "published")
        const hasPromotion = body.promoted !== undefined

        if (!hasStatus && !hasPromotion) {
            callback(null, {
                statusCode: 403,
                headers: makeHeader('application/json' ),
                body: JSON.stringify({ "message": "The new status should be valid, or a promotion status set" })
            });
            return;
        }

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

        // make sure the current cognito user has high enough access lvl
        const promises = Promise.all([
            hasStatus ? updateCategoryStatus(body.status, name, brand) : 0,
            hasPromotion ? updateCategoryPromoted(body.promoted, name, brand) : 0
        ])
        const result = await promises
        const updateSuccess = result[0] || result[1]
        console.log("Set status ", body.status , " , promoted: ", body.promoted, " of Category ", name ," in db success: ", updateSuccess)
        const category = convertStoredCategory(updateSuccess.Attributes)

        const response = {
            statusCode: 200,
            headers: makeHeader('application/json' ),
            body: JSON.stringify({
                "message": "Category status update successful",
                "item": category
            })
        };
    
        callback(null, response);
    } catch(error) {
        console.error('Failed to update category: ', JSON.stringify(error, null, 2));
        callback(error, {
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

    if (!id || !brand) {
        callback(null, {
            statusCode: 403,
            headers: makeHeader('text/plain'),
            body: `Expected both a brand and a user-id, one is missing.`,
        });
        return;
    }

    console.log(cognitoUserName, " wants to delete category named: ", id, " from brand ", brand)
    try {
        // make sure the current cognito user has high enough access lvl
        const accessLvlPromise = getAccessLvl(cognitoUserName, brand);

        const ownAccessLvl = await accessLvlPromise;
        if (!accessLvlMayCreate(ownAccessLvl)) {
            const msg = `User ${cognitoUserName} is not allowed to delete categories of ${brand}`
            callback(null, {
                statusCode: 403,
                headers: makeHeader('application/json' ),
                body: JSON.stringify({ "message": msg })
            });
            return;
        }

        const dbDeletionResponse = await deleteCategoryFromDB(id, brand)
        console.log("dbDeletionResponse: ", dbDeletionResponse)

        const response = {
            statusCode: 200,
            headers: makeHeader('application/json'),
            body: JSON.stringify({ "message": "Deletion of category " + id + " successful" })
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