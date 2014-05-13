"use strict";

var util = require('util');
var async = require('async');

exports.RedisDatabase = (function(){
    function RedisDatabase(redisClient, instanceId){
        this.redisClient = redisClient;
        this.instanceId = instanceId;
        this.expireKeyUpdateTimer = null;
    };

    RedisDatabase.prototype.runExpireKeyUpdateTimer = function(){
        var _this = this;

        if (!_this.expireKeyUpdateTimer){
            _this.expireKeyUpdateTimer = setInterval(function(){
                _this.redisClient.keys('Expire:' + _this.instanceId + ':*', function(err, result){
                    if (err || !Array.isArray(result)){

                    }
                    else{
                        if (result.length === 0){
                            clearInterval(_this.expireKeyUpdateTimer);
                            _this.expireKeyUpdateTimer = null;
                        }
                        else{
                            var multi = _this.redisClient.multi();
                            for (var i in result){
                                multi.pexpire(result[i], 10000);
                            }
                            multi.exec();
                        }
                    }
                });
            }, 3000);
        }
    };

    RedisDatabase.prototype.userKey = function (channelId, userId, propertyName){
        return "Channel:" + channelId + ":User:" + userId + ":" + propertyName;
    };

    RedisDatabase.prototype.addUserToChannel = function (channelId, userId, userName, callback){
        var _redisClient = this.redisClient;

        var channelSetKey = "ChannelSet";
        var channelUserSetKey = "Channel:" + channelId + ":UserSet";
        var userChannelSetKey = "User:" + userId + ":ChannelSet";
        var userNameInChannelKey = this.userKey(channelId, userId, 'name');

        _redisClient
            .multi()
            .sadd(channelSetKey, channelId)
            .sadd(channelUserSetKey, userId)
            .sadd(userChannelSetKey, channelId)
            .set(userNameInChannelKey, userName)
            .exec(callback);
    };

    RedisDatabase.prototype.removeUserFromChannel = function (channelId, userId, callback){
        var _redisClient = this.redisClient;

        var channelSetKey = "ChannelSet";
        var channelUserSetKey = "Channel:" + channelId + ":UserSet";
        var userChannelSetKey = "User:" + userId + ":ChannelSet";
        var userNameInChannelKey = this.userKey(channelId, userId, 'name');
        var expireKey = 'Expire:*:Connection:*:' + this.userKey(channelId, userId, 'isAlive');

        _redisClient
            .multi()
            .keys(expireKey)
            .srem(channelUserSetKey, userId)
            .srem(userChannelSetKey, channelId)
            .del(userNameInChannelKey)
            .exec(function(err, result){
                if (err){
                    callback(err, result);
                }
                else{
                    var connectionKeys = result[0];
                    async.waterfall([
                        function(aCallback){
                            _redisClient.del(connectionKeys, aCallback);
                        },
                        function(result, aCallback){
                            _redisClient.scard(channelUserSetKey, aCallback);
                        },
                        function(number, aCallback){
                            if (number == 0){
                                _redisClient.srem(channelSetKey, channelId, aCallback);
                            }
                            else{
                                callback(null, number);
                            }
                        }
                    ], callback);
                }
            });
    };

    RedisDatabase.prototype.getUserName = function (channelId, userId, callback){
        this.getUserProperty(channelId, userId, 'name', callback);
    }

    RedisDatabase.prototype.setUserName = function (channelId, userId, userName, callback){
        this.setUserProperty(channelId, userId, 'name', userName, callback);
    }

    RedisDatabase.prototype.getUserProperty = function (channelId, userId, propertyName, callback){
        this.redisClient.get(this.userKey(channelId, userId, propertyName), callback);
    }

    RedisDatabase.prototype.getUserProperties = function (channelId, userId, propertyNames, callback){
        var _this = this;
        if (propertyNames && Array.isArray(propertyNames)){
            var keys = propertyNames.map(function(name){return _this.userKey(channelId, userId, name);});
            this.redisClient.mget(keys, callback);
        }
        else{
            callback('bad property name', []);
        }
    }

    RedisDatabase.prototype.setUserProperty = function(channelId, userId, propertyName, value, callback){
        this.redisClient.set(this.userKey(channelId, userId, propertyName), value, callback);
    };

    RedisDatabase.prototype.getUserFromChannel = function(channelId, userId, callback){
        var _this = this;
        var _redisClient = this.redisClient;
        var userProperties = ['name'];

        var propertyKeys = userProperties.map(function(property){return _this.userKey(channelId, userId, property);});
        var expireKey = 'Expire:*:Connection:*:' + _this.userKey(channelId, userId, 'isAlive');

        var multi = _redisClient.multi();
        multi.mget(propertyKeys);
        multi.keys(expireKey);
        multi.exec(function(err, replies){
            var properties = replies[0];
            var connections = replies[1];

            if (err || !Array.isArray(replies) || replies.length !== 2){
                callback(err || 'can not find user.', null);
            }
            else{
                var user = {
                    id : userId,
                    connections : connections
                };
                for (var i in userProperties){
                    user[userProperties[i]] = properties[i];
                }
                callback(null, user);
            }
        });
    };

    RedisDatabase.prototype.getUsersFromChannel = function(channelId, callback){
        var _this = this;
        var _redisClient = this.redisClient;

        var channelUserSetKey = "Channel:" + channelId + ":UserSet";

        _redisClient.smembers(channelUserSetKey, function(err, userIds){
            if (err || !(userIds instanceof Array) || userIds.length <= 0){
                callback(err, []);
            }
            else{
                var userProperties = ['name'];
                var multi = _redisClient.multi();
                userIds.forEach(function(userId){
                    multi.mget(userProperties.map(function(property){return _this.userKey(channelId, userId, property);}));
                });
                userIds.forEach(function(userId){
                    var expireKey = 'Expire:*:Connection:*:' + _this.userKey(channelId, userId, 'isAlive');
                    multi.keys(expireKey);
                });
                multi.exec(function(err, replies){
                    if (!err && userIds.length === replies.length /2){
                        var properties = replies.slice(0, replies.length/2);
                        var connectionKeys = replies.slice(replies.length/2);
                        var index = 0;
                        var users = userIds.map(function(userId){
                            var user = {
                                id : userId
                            }
                            for (var i in userProperties){
                                user[userProperties[i]] = properties[index][i];
                            }
                            user['connections'] = connectionKeys[index];
                            index++;
                            return user;
                        });

                        callback(err, users);
                    }
                    else{
                        callback(err, []);
                    }
                });
            }
        });
    };

    RedisDatabase.prototype.getChannelsFromUser = function(userId, callback){
        var _redisClient = this.redisClient;

        var userChannelSetKey = "User:" + userId + ":ChannelSet";

        _redisClient.smembers(userChannelSetKey, function(err, channelIds){
            if (err || !(channelIds instanceof Array) || channelIds.length <= 0){
                callback(err, []);
            }
            else{
                var multi = _redisClient.multi();
                channelIds.forEach(function(item){multi.hgetall('ChannelHash:'+item);});
                multi.exec(function(err, replies){
                    if (err){
                        callback(err, replies);
                    }
                    else{
                        if (channelIds.length === replies.length){
                            for (var i = 0; i < channelIds.length; ++i){
                                replies[i]['id'] = channelIds[i];
                            }
                        }

                        callback(err, replies);
                    }
                });
            }
        });
    };

    RedisDatabase.prototype.getAllChannelsKey = function(callback){
        this.redisClient.smembers("ChannelSet", callback);
    };

    RedisDatabase.prototype.addTalkHistory = function(channelId, talk, callback){
        var channelHistoryKey = "Channel:" + channelId + ":HistoryList";
        var talkJson = JSON.stringify(talk);
        this.redisClient
            .multi()
            .lpush(channelHistoryKey, talkJson)
            .ltrim(channelHistoryKey, 0, 100)
            .exec(callback);
    };

    RedisDatabase.prototype.getTalkHistory = function(channelId, callback){
        var channelHistoryKey = "Channel:" + channelId + ":HistoryList";
        this.redisClient.lrange(channelHistoryKey, 0, 100, function(err, talkJsons){
            if (err || !talkJsons || !Array.isArray(talkJsons)){
                callback(err, talkJsons);
            }
            else{
                var talks = talkJsons.map(function(talkJson){return JSON.parse(talkJson);}).reverse();
                callback(err, talks);
            }
        });
    };

    RedisDatabase.prototype.setUserOnline = function(connectionId, channelId, userId, callback){
        var _this = this;
        var expireKey = 'Expire:' + this.instanceId + ':Connection:' + connectionId + ':' + this.userKey(channelId, userId, 'isAlive');
        this.redisClient.set(expireKey, true, function(err, result){
            _this.runExpireKeyUpdateTimer();
            callback(err, result);
        });
    };

    RedisDatabase.prototype.setUserOffline = function(connectionId, channelId, userId, callback){
        var expireKey = 'Expire:' + this.instanceId + ':Connection:' + connectionId + ':' + this.userKey(channelId, userId, 'isAlive');
        this.redisClient.del(expireKey, callback);
    };

    RedisDatabase.prototype.getUserConnections = function(channelId, userId, callback){
        var expireKey = 'Expire:*:Connection:*:' + this.userKey(channelId, userId, 'isAlive');
        this.redisClient.keys(expireKey, callback);
    };

    return RedisDatabase;
})();
