/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const sns = new AWS.SNS({region: 'eu-west-1'});

function makeHeader(content) {
    return { 
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true,
        'Content-Type': content
    };
}

exports.forwardError = async (event, context, callback) => {

    console.log("event: ", event)

    let notification = event.Records && event.Records[0] && event.Records[0].Sns

    try {

        if (!notification) return

        var params = {
            TopicArn: process.env.snsArn,
            Message: notification.Message, 
            Subject: notification.Subject,
            MessageAttributes: {
                'AWS.SNS.SMS.SenderID': {
                    DataType: 'String',
                    StringValue: 'LooCARCMS'
                },
                'AWS.SNS.SMS.SMSType': {
                    DataType: 'String',
                    StringValue: 'Transactional'
                }
            }
        };

        return sns.publish(params).promise()

    } catch(error) {
        console.error('Query failed to load data. Error: ', error);
        callback(null, {
            statusCode: error.statusCode || 501,
            headers: makeHeader('text/plain'),
            body: `Encountered error ${error}`,
        });
        return;
    }
};
