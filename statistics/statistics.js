/*jslint node: true */

'use strict';

const aws = require('aws-sdk'); 
aws.config.update({region: process.env.AWS_REGION})
const AthenaExpress = require("athena-express");
const brandSettings = require('brand_settings.json')

const ATHENA_DB = 'apic_cloudfront_logs'
const ATHENA_OUTPUT_LOCATION = 's3://looc-ar-api-statistics/query-results/'

const athenaExpressConfig = {
	aws, /* required */
	s3: ATHENA_OUTPUT_LOCATION, /* optional */
    db: ATHENA_DB, /* optional */
	formatJson: true, /* optional default=true */
	retry: 200, /* optional default=200 */
    getStats: false /* optional default=false */
};
const athenaExpress = new AthenaExpress(athenaExpressConfig);
const dynamoDb = new aws.DynamoDB.DocumentClient();


const RESULT_SIZE = 1000

const getBrandAppDataHits = async (brand, appAgentName) => {
    let query = {
        sql: `
        SELECT user_agent
        FROM apic_cloudfront_logs 
        WHERE 
        (
        "date" BETWEEN DATE '2020-10-12' AND DATE '2020-10-13' AND
        "uri" LIKE '%${brand}/app-data%' AND
        "user_agent" LIKE '${appAgentName}%' AND
        "query_string" = '-'
        )
        LIMIT ${RESULT_SIZE};
        `
    }

    return athenaExpress.query(query)
}

// Queries the cloudfront logs for the appData
exports.appData = async (event, context, callback) => {
    try {
        const brands = Object.keys(brandSettings)

        let promises = brands
            .filter( brand => brandSettings[brand].AppAgentName !== undefined )
            .map( brand => {
                return getBrandAppDataHits(brand, brandSettings[brand].AppAgentName)
            })

		let results = await Promise.all(promises)
		console.log(results);
	} catch (error) {
		console.log(error);
	}
}