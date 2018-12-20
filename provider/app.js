'use strict';
/**
 * Service which can be configured to listen for triggers from a provider.
 * The Provider will store, invoke, and POST whisk events appropriately.
 */
var URL = require('url').URL;
var http = require('http');
var express = require('express');
var bodyParser = require('body-parser');
var bluebird = require('bluebird');
var logger = require('./Logger');

//var ProviderUtils = require('./lib/utils.js');
var ProviderTriggersManager = require('./lib/triggers_manager.js');
var ProviderHealth = require('./lib/health.js');
var ProviderRAS = require('./lib/ras.js');
var ProviderActivation = require('./lib/active.js');
var constants = require('./lib/constants.js');

// Initialize the Express Application
var app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.set('port', process.env.PORT || 8080);

// Allow invoking servers with self-signed certificates.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// If it does not already exist, create the triggers database.  This is the database that will
// store the managed triggers.
var dbUrl = process.env.DB_URL;
var dbPrefix = process.env.DB_PREFIX;
var databaseName = dbPrefix + constants.TRIGGER_DB_SUFFIX;
// OPTIONAL
var redisUrl = process.env.REDIS_URL;

// OPTIONAL
var monitoringAuth = process.env.MONITORING_AUTH;
var monitoringInterval = process.env.MONITORING_INTERVAL || constants.MONITOR_INTERVAL;

var filterDDName = '_design/' + constants.FILTERS_DESIGN_DOC;
var viewDDName = '_design/' + constants.VIEWS_DESIGN_DOC;

if (!process.env.EVENT_PROVIDER) {
  throw new Exception('Missing EVENT_PROVIDER environment parameter.')
}

const EventProvider = require(process.env.EVENT_PROVIDER)

// Create the Provider Server
var server = http.createServer(app);
server.listen(app.get('port'), function() {
    logger.info('server.listen', 'Express server listening on port ' + app.get('port'));
});

function createDatabase() {
    var method = 'createDatabase';
    logger.info(method, 'creating the trigger database');

    console.log(dbUrl);
    var cloudant = require('@cloudant/cloudant')(dbUrl);

    if (cloudant !== null) {
        return new Promise(function (resolve, reject) {
            cloudant.db.create(databaseName, function (err, body) {
                if (!err) {
                    logger.info(method, 'created trigger database:', databaseName);
                }
                else if (err.statusCode !== 412) {
                    logger.info(method, 'failed to create trigger database:', databaseName, err);
                }

                var viewDD = {
                    views: {
                        triggers_by_worker: {
                            map: function (doc) {
                                if (doc.maxTriggers && (!doc.status || doc.status.active === true)) {
                                    emit(doc.worker || 'worker0', 1);
                                }
                            }.toString(),
                            reduce: '_count'
                        }
                    }
                };

                createDesignDoc(cloudant.db.use(databaseName), viewDDName, viewDD)
                .then(db => {
                    var filterDD = {
                        filters: {
                            triggers_by_worker:
                                function (doc, req) {
                                    return doc.maxTriggers && ((!doc.worker && req.query.worker === 'worker0') ||
                                            (doc.worker === req.query.worker));
                                }.toString()
                        }
                    };
                    return createDesignDoc(db, filterDDName, filterDD);
                })
                .then(db => {
                    if (monitoringAuth) {
                        var filterDD = {
                            filters: {
                                canary_docs:
                                    function (doc, req) {
                                        return doc.isCanaryDoc && doc.host === req.query.host;
                                    }.toString()
                            }
                        };
                        return createDesignDoc(db, '_design/' + constants.MONITOR_DESIGN_DOC, filterDD);
                    }
                    else {
                        return Promise.resolve(db);
                    }
                })
                .then((db) => {
                    resolve(db);
                })
                .catch(err => {
                    reject(err);
                });

            });
        });
    }
    else {
        Promise.reject('cloudant provider did not get created.  check db URL: ' + dbUrl);
    }
}

function createDesignDoc(db, ddName, designDoc) {
    var method = 'createDesignDoc';

    return new Promise(function(resolve, reject) {

        db.get(ddName, function (error, body) {
            if (error) {
                //new design doc
                db.insert(designDoc, ddName, function (error, body) {
                    if (error && error.statusCode !== 409) {
                        logger.error(method, error);
                        reject('design doc could not be created: ' + error);
                    }
                    else {
                        resolve(db);
                    }
                });
            }
            else {
                resolve(db);
            }
        });
    });
}

function createRedisClient() {
    var method = 'createRedisClient';

    return new Promise(function(resolve, reject) {
        if (redisUrl) {
            var client;
            var redis = require('redis');
            bluebird.promisifyAll(redis.RedisClient.prototype);
            if (redisUrl.startsWith('rediss://')) {
                // If this is a rediss: connection, we have some other steps.
                client = redis.createClient(redisUrl, {
                    tls: { servername: new URL(redisUrl).hostname }
                });
                // This will, with node-redis 2.8, emit an error:
                // "node_redis: WARNING: You passed "rediss" as protocol instead of the "redis" protocol!"
                // This is a bogus message and should be fixed in a later release of the package.
            } else {
                client = redis.createClient(redisUrl);
            }

            client.on('connect', function () {
                resolve(client);
            });

            client.on('error', function (err) {
                logger.error(method, 'Error connecting to redis', err);
                reject(err);
            });
        }
        else {
            resolve();
        }
    });
}

// Initialize the Provider Server
function init(server, EventProvider) {
    var method = 'init';
    var cloudantDb;
    var providerTriggersManager;

    if (server !== null) {
        var address = server.address();
        if (address === null) {
            logger.error(method, 'Error initializing server. Perhaps port is already in use.');
            process.exit(-1);
        }
    }

    createDatabase()
    .then(db => {
        cloudantDb = db;
        return createRedisClient();
    })
    .then(client => {
        providerTriggersManager = new ProviderTriggersManager(logger, cloudantDb, EventProvider, client);
        return providerTriggersManager.initRedis();
    })
    .then(() => {
        var providerRAS = new ProviderRAS();
        var providerHealth = new ProviderHealth(logger, providerTriggersManager);
        var providerActivation = new ProviderActivation(logger, providerTriggersManager);

        // RAS Endpoint
        app.get(providerRAS.endPoint, providerRAS.ras);

        // Health Endpoint
        app.get(providerHealth.endPoint, providerTriggersManager.authorize, providerHealth.health);

        // Activation Endpoint
        app.get(providerActivation.endPoint, providerTriggersManager.authorize, providerActivation.active);

        providerTriggersManager.initAllTriggers();

        if (monitoringAuth) {
            setInterval(function () {
                providerHealth.monitor(monitoringAuth, monitoringInterval);
            }, monitoringInterval);
        }
    })
    .catch(err => {
        logger.error(method, 'an error occurred creating database:', err);
    });

}

init(server, EventProvider);
