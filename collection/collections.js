/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 

function makeHeader(content) {
    return { 
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true,
        'Cache-Control': 'max-age=10,must-revalidate',
        'Content-Type': content
    };
}

// Cached, public collections endpoint
exports.all = async (event, context, callback) => {
    callback(null, {
        statusCode: 200,
        headers: makeHeader('text/plain'),
        body: JSON.stringify({message: 'Those are them collections'})
    });
};
