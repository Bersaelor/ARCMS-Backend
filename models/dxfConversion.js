/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const ec2 = new AWS.EC2();

function startInstance(file, sizeInMB) {
    const init_script = `
    #!/bin/bash
    /usr/bin/apt-get update
    /usr/bin/apt-get -y install awscli
    /usr/bin/aws s3 cp s3://ec2-looc-storage/dxf2svg-init.sh /tmp/ 
    /bin/chmod +x /tmp/dxf2svg-init.sh
    /tmp/dxf2svg-init.sh ${ file }
    `
    const base64Script = Buffer.from(init_script).toString('base64')
    var instanceType = "t2.small"

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

exports.convert = async (event, context, callback) => {
    for (const index in event.Records) {
        const record = event.Records[index]
        const key = record.s3.object.key
        const sizeInMB = record.s3.object.size / (1024 * 1024)

        console.log("sizeInMB: ", sizeInMB)

        console.log(`${key} was added to models bucket, starting EC2 instance to convert it to usdz`)

        try {
            const response = await startInstance(key, sizeInMB)
            console.log("Success: ", response.Instances, " Instances created")
        } catch(error) {
            console.log("Failed: ", error)
            return callback(error)
        }
    }
}