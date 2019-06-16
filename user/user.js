'use strict';


exports.get = async function(event, context, callback){

    console.log("Event: ", event);

    var cognitoUserName = event.requestContext.authorizer.claims["cognito:username"];
    const response = {
        statusCode: 200,
        headers: {
            "x-custom-header" : "My Header Value"
        },
    body: JSON.stringify({ 
            message: "Hello World!",
            cognitoUserName: cognitoUserName
        })
    };

    callback(null, response);
}
