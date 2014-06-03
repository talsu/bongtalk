var redis = require("redis");
var util = require('util');

exports.createRedisClient = function(redisUrl, option){
    if (redisUrl){
        var rtg   = require("url").parse(redisUrl);
        var redisClient = redis.createClient(rtg.port || 6379, rtg.hostname, option);
        if (rtg.auth)
        {
            var authString = rtg.auth;
            if (authString.indexOf(':') !== -1) {
                authString = authString.split(":")[1];
            }

            redisClient.auth(authString);
        }

        return redisClient;
    }
    else{
        return redis.createClient("127.0.0.1", 6379, option);
    }
};

exports.log = function(obj){
    util.log(util.inspect(obj));
};

exports.pLog = function(message){
    util.log('[pid:' + process.pid + '] ' + message);
};