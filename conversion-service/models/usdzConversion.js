/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const ec2 = new AWS.EC2();
const path = require('path');
const dynamoDb = new AWS.DynamoDB.DocumentClient();

function startInstance(file, sizeInMB) {
    const init_script = `
    #!/bin/bash
    /usr/bin/aws s3 cp s3://ec2-looc-storage/ec2-init.sh /tmp/ 
    /usr/bin/chmod +x /tmp/ec2-init.sh
    /tmp/ec2-init.sh ${ file }
    `
    
    const base64Script = Buffer.from(init_script).toString('base64')
    var instanceType
    if (sizeInMB > 40) {
        instanceType = "t2.medium"
    } else if (sizeInMB > 15) {
        instanceType = "t2.small"
    } else {
        instanceType = "t2.micro"
    }

    var params = {
        ImageId: "ami-0d4c3eabb9e72650a",
        InstanceType: instanceType,
        KeyName: "Convert3DEC2Pair",
        MaxCount: 1,
        MinCount: 1,
        SecurityGroupIds: [ "sg-d572aabd" ],
        IamInstanceProfile: {
            Arn: "arn:aws:iam::338756162532:instance-profile/EC2Convert3DModelw"
        },
        InstanceInitiatedShutdownBehavior: "terminate",
        UserData: base64Script
    };

    return new Promise((resolve, reject) => {
        let request = ec2.runInstances(params, (error, data) => {
            if (error) reject(error); 
            else resolve(data);
        });
    })
}

async function getModel(brand, category, id) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "sk, modelFile",
        KeyConditionExpression: "#id = :value and #sk = :searchKey",
        ExpressionAttributeNames:{
            "#id": "id",
            "#sk": "sk"
        },
        ExpressionAttributeValues: {
            ":value": `${brand}#model`,
            ":searchKey": `${category}#${id}`
        },
    };

    return dynamoDb.query(params).promise()
}

async function updateModel(key, value, name, brand, category) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        Key: {id: `${brand}#model`, sk: `${category}#${name}` },
        UpdateExpression: `set ${key} = :value`,
        ExpressionAttributeValues: {
            ':value' : value,
        },
    };

    return dynamoDb.update(params).promise()
}

// Check the dynamoDB for the model entry, if no modelFile value is 
function checkAndUpdateDBIfNecessary(key) {
    const parsedPath = path.parse(key)
    const fileName = parsedPath.name
    const brand = key.split('/')[1]
    const category = key.split('/')[2]
    const dashSeparated = parsedPath.name.split('-')
    const timestamp = dashSeparated.pop() // pop the timestamp
    const modelId = dashSeparated.join('-')

    // load the model entry and check whether the model file name is older then the *.glb file
    // if the glb file is converted from a modelFile dae, then it would have an equal timestring
    
    return getModel(brand, category, modelId).then ( result => {
        if (!result || !result.Items || result.Items.length == 0) {
            throw `Failed to find model with brand: ${brand}, category: ${category}, modelId: ${modelId} in DB`
        }
        const model = result.Items[0];
        if (model.modelFile) {
            const existingTimestamp = path.parse(model.modelFile).name.split('-').pop();
            if (existingTimestamp < timestamp) {
                console.log("Existing modelFile of " + modelId + " was older then " + fileName + " so overwriting modelFile"); 
                return updateModel("modelFile", key, modelId, brand, category)
            }
        } else {
            console.log("Existing " + modelId + " has no modelFile entry, updating to " + fileName); 
            return updateModel("modelFile", key, modelId, brand, category)
        }
        return "No update necessary"
    });
}

// Convert glb files deposited into s3/original to usdz, but also create an encrypted glb copy
exports.convert = async (event, context, callback) => {
    for (const index in event.Records) {
        const record = event.Records[index]
        const key = record.s3.object.key
        const sizeInMB = record.s3.object.size / (1024 * 1024)

        console.log(`${key} was added to models bucket, starting EC2 instance to convert it to usdz`)

        try {
            const response = await Promise.all([
                startInstance(key, sizeInMB),
                checkAndUpdateDBIfNecessary(key)
            ])
            console.log("Success: ", response[0].Instances, " Instances created and DB update Response: " + response[1])
        } catch(error) {
            console.log("Failed: ", error)
            return callback(error)
        }
    }
}