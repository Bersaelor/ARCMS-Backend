/*jslint node: true */

'use strict';

const aws = require('aws-sdk'); 
aws.config.update({region: process.env.AWS_REGION})
const AthenaExpress = require("athena-express");
const brandSettings = require('brand_settings.json')

const apic_log_table = 'apic_cloudfront_logs'
const ATHENA_OUTPUT_LOCATION = 's3://looc-ar-api-statistics/query-results/'

const athenaExpressConfig = {
	aws, /* required */
    db: 'default',
	s3: ATHENA_OUTPUT_LOCATION, /* optional */
	formatJson: true, /* optional default=true */
	retry: 200, /* optional default=200 */
    getStats: false /* optional default=false */
};
const athenaExpress = new AthenaExpress(athenaExpressConfig);
const dynamoDb = new aws.DynamoDB.DocumentClient();

const RESULT_SIZE = 1000

const dateToSQL = (date) => {
    return date.toISOString().split('T')[0]
}

const getBrandAppDataHits = async (brand, from, to, appAgentName) => {
    let query = {
        sql: 
`SELECT user_agent\
FROM ${apic_log_table} \
WHERE \
(\
"date" BETWEEN DATE '${dateToSQL(from)}' AND DATE '${dateToSQL(to)}' AND\
"uri" LIKE '%${brand}/app-data%' AND\
"user_agent" LIKE '${appAgentName}%' AND\
"query_string" = '-'\
)\
LIMIT ${RESULT_SIZE};\
`
    }
    console.log("Query: ", query)

    return athenaExpress.query(query)
}

// Queries the cloudfront logs for the appData
exports.appData = async (event, context, callback) => {
    var day = new Date(event.time) 
    day.setHours(1, 0, 0, 0)

    var dayBefore = new Date(day.getTime())
    dayBefore.setDate(day.getDate() - 1)

    try {
        const brands = Object.keys(brandSettings)

        let promises = brands
            .filter( brand => brandSettings[brand].AppAgentName !== undefined )
            .map( brand => {
                return getBrandAppDataHits(brand, dayBefore, day, brandSettings[brand].AppAgentName)
            })

		let results = await Promise.all(promises)
		console.log(results);
	} catch (error) {
		console.log(error);
	}
}