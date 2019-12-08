/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const path = require('path');
const ec2 = new AWS.EC2();

exports.convert = async (event, context, callback) => {
    for (const index in event.Records) {
        const record = event.Records[index]
        const key = record.s3.object.key

        console.log(`${key} was added to models bucket, starting EC2 instance to convert it to usdz`)

        const init_script = `
        #!/bin/bash
        /usr/bin/aws s3 cp s3://ec2-looc-storage/ec2-init.sh /tmp/ 
        /usr/bin/chmod +x /tmp/ec2-init.sh
        /tmp/ec2-init.sh ${ path.basename(key) }
        `

        var params = {
            ImageId: "ami-0d4c3eabb9e72650a",
            InstanceType: "t2.micro",
            KeyName: "Convert3DEC2Pair",
            MaxCount: 1,
            MinCount: 1,
            SecurityGroupIds: [ "sg-d572aabd" ],
            IamInstanceProfile: {
                Arn: "arn:aws:iam::338756162532:instance-profile/EC2Convert3DModelw", 
                Name: "EC2Convert3DModelw"
            },
            InstanceInitiatedShutdownBehavior: "terminate",
            UserData: init_script
        };

        console.log("params: ", params)

        ec2.runInstances(params, (err, data) => {
            if (err) console.log(err, err.stack); // an error occurred
            else console.log("Success: ", data); // successful response
        });
    }
}