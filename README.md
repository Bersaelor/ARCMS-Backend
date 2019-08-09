This project uses the [`serverless`](https://serverless.com) framework.

The `serverless.yml` file creates a layer of indirection between this project and aws, to be less specific about the provider.

This repo is for the backend and together with the [React frontend](https://github.com/Bersaelor/cms-react) the architecture looks like the following:

![AWS Architecture](/serverless-architecture.png?raw=true)

To deploy everything you can type

### `serverless deploy`

or 

### `sls deploy` 

or if you just want to deploy single functions you can do

### `sls deploy function -f helloWorld` 

.

In order to have access to AWS you might need AWS credentials.


