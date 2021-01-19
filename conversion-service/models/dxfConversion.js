/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const ec2 = new AWS.EC2();
const path = require('path');
const dynamoDb = new AWS.DynamoDB.DocumentClient();

function startInstance(file) {
    const init_script = `#!/bin/bash -x
echo Initializing DXFConversion
apt-get update
apt-get -y install awscli
aws s3 cp s3://ec2-looc-storage/dxf2svg-init.sh /tmp/ 
chmod +x /tmp/dxf2svg-init.sh
/tmp/dxf2svg-init.sh ${ file }
`
    const base64Script = Buffer.from(init_script).toString('base64')
    var instanceType = "t2.micro"

    var params = {
        ImageId: "ami-0cc0a36f626a4fdf5",
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
        ProjectionExpression: "sk, dxfFile",
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

async function saveDxfIntoDBEntry(brand, category, modelId, uploadedTimestamp, uploadedKey) {
    const modelData = await getModel(brand, category, modelId)
    if (!modelData || !modelData.Items || modelData.Items.length == 0) {
        const msg = `Failed to find model with brand: ${brand}, category: ${category}, modelId: ${modelId} in DB`
        console.error(msg)
        return
    }

    const model = modelData.Items[0]
    if (model.dxfFile) {
        const parsedPath = path.parse(model.dxfFile)
        const oldDXFFileName = parsedPath.name
        const dashSeparated = oldDXFFileName.split('-')
        const existingTimestamp = dashSeparated.pop() // pop the timestamp
        if (existingTimestamp > uploadedTimestamp) {
            console.log(`Existing file ${oldDXFFileName} is newer then uploaded with timestamp ${uploadedTimestamp}, not changing db entry`)
            return
        }    
    }

    const updateSuccess = await updateModel("dxfFile", uploadedKey, modelId, brand, category)
    console.log("Updating dxfFile to ", uploadedKey, " in db success: ", updateSuccess)    
}


// Convert dxf files deposited into s3/original to svg and save newly uploaded dxf as dxffile
exports.convert = async (event, context, callback) => {
    for (const index in event.Records) {
        const record = event.Records[index]
        const key = record.s3.object.key

        // for model updating
        const parsedPath = path.parse(key)
        const brand = key.split('/')[1]
        const category = key.split('/')[2]
        const dashSeparated = parsedPath.name.split('-')
        const timestamp = dashSeparated.pop() // pop the timestamp
        const modelId = dashSeparated.join('-')

        console.log(`${key} was added to models bucket, starting EC2 instance to convert it to svg`)

        try {
            let updateDBEntryPromise = saveDxfIntoDBEntry(brand, category, modelId, timestamp, key)

            const response = await startInstance(key)
            const updateDBResult = await updateDBEntryPromise
            console.log("Success: ", response.Instances, " Instances created and db updated: ", updateDBResult)
        } catch(error) {
            console.log("Failed: ", error)
            return callback(error)
        }
    }
}