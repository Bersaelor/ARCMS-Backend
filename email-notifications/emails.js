/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 

// Delete a device from the current user
exports.newOrder = async (event, context, callback) => {
    console.log("event: ", event)

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