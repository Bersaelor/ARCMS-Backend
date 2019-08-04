/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 

function makeHeader(content) {
    return { 
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true,
        'Content-Type': content
    };
}

// Delete a device from the current user
exports.newOrder = async (event, context, callback) => {
    const firstRecord = event.Records[0]
    if (!firstRecord || !firstRecord.Sns) {
        throw "Failed to get firstRecord or Sns entry"
    }
    const message = firstRecord.Sns
    let order = JSON.parse(message.Message)
    let storeEmail = message.MessageAttributes.storeEmail.Value
    let brand = message.MessageAttributes.brand.Value
    if (!order || !storeEmail || !brand) {
        throw "Failed to get bodyJSON, storeEmail, brand entry"
    }

    console.log("Received order-notification from ", storeEmail, " for brand ", brand)

    console.log("order: ", order)

    try {
        const response = {
            statusCode: 200,
            headers: makeHeader('application/json'),
            body: JSON.stringify({ "message": "Sending of emails was successful" })
        };
    
        callback(null, response);
    } catch(err) {
        console.error('Sending email notifications failed. Error JSON: ', JSON.stringify(err, null, 2));
        const response = {
            statusCode: err.statusCode || 501,
            headers: makeHeader('text/plain'),
            body: 'Failed to send emails because of ' + err,
        };
        callback(null, response);
        return;
    }
};