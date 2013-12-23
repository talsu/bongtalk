/**
 * Created by Talsu on 13. 11. 22.
 */
"use strict";

var util = require('util');

exports.JadeDataBinder = (function(){
    function JadeDataBinder(bongtalk){
        this.bongtalk = bongtalk;
        this.zones = [];
    };

    JadeDataBinder.prototype.loadData = function(callback){
        var _this = this;
        this.zones = [];
        this.bongtalk.database.getAllZonesKey(function(err, zoneIds){

            if (err || !zoneIds || zoneIds.length == 0){
                callback();
                return;
            }

            _this.zones = zoneIds.map(function(item){return {id:item, users:[]};});

            var numCompletedCalls = 0
            _this.zones.forEach(function(zone){
                _this.bongtalk.database.getUsersFromZone(zone.id, function(err, users){
                    zone.users = users;
                    numCompletedCalls++;
                    if (numCompletedCalls == _this.zones.length){
                        numCompletedCalls = 0;
                        callback();
                    }
                });
            });
        });
    };

    JadeDataBinder.prototype.getZones = function(){
        return this.zones;
    };

    JadeDataBinder.prototype.getUsers = function(zoneId){
        for (var i = 0; i < this.zones.length; ++i){
            if (this.zones[i].id == zoneId){
                return this.zones[i].users
            }
        }

        return [];
    };

    return JadeDataBinder;
})();

exports.RedisDatabase = (function(){
    function RedisDatabase(redisClient){
        this.redisClient = redisClient;
    };

//    RedisDatabase.prototype.getOrCreateUser = function (userId, callback) {
//        this.getOrCreateHash('User', userId, callback);
//    };

    RedisDatabase.prototype.addUserToZone = function (zoneId, userId, userName, callback){
        var _redisClient = this.redisClient;

        var zoneSetKey = "ZoneSet";
        var zoneUserSetKey = "Zone:" + zoneId + ":UserSet";
        var userZoneSetKey = "User:" + userId + ":ZoneSet";
        var userNameInZoneKey = "Zone:" + zoneId + ":User:" + userId + ":name";

        _redisClient
            .multi()
            .sadd(zoneSetKey, zoneId)
            .sadd(zoneUserSetKey, userId)
            .sadd(userZoneSetKey, zoneId)
            .set(userNameInZoneKey, userName)
            .exec(callback);
    };

    RedisDatabase.prototype.removeUserFromZone = function (zoneId, userId, callback){
        var _redisClient = this.redisClient;

        var zoneSetKey = "ZoneSet";
        var zoneUserSetKey = "Zone:" + zoneId + ":UserSet";
        var userZoneSetKey = "User:" + userId + ":ZoneSet";
        var userNameInZoneKey = "Zone:" + zoneId + ":User:" + userId + ":name";
        var userStatusInZoneKey = "Zone:" + zoneId + ":User:" + userId + ":status";

        _redisClient
            .multi()
            .srem(zoneUserSetKey, userId)
            .srem(userZoneSetKey, zoneId)
            .del(userNameInZoneKey)
            .del(userStatusInZoneKey)
            .exec(function(err, result){
                if (err){
                    callback(err, result);
                }
                else{
                    _redisClient.scard(zoneUserSetKey, function(err, number){
                        if (!err && number == 0){
                            _redisClient.srem(zoneSetKey, zoneId, callback);
                        }
                        else{
                            callback(err, number);
                        }
                    })
                }
            });
    };

    RedisDatabase.prototype.getUserName = function (zoneId, userId, callback){
        this.getUserProperty(zoneId, userId, 'name', callback);
    }

    RedisDatabase.prototype.setUserName = function (zoneId, userId, userName, callback){
        this.setUserProperty(zoneId, userId, 'name', userName, callback);
    }

    RedisDatabase.prototype.getUserProperty = function (zoneId, userId, propertyName, callback){
        var key = "Zone:" + zoneId + ":User:" + userId + ":" + propertyName;
        this.redisClient.get(key, callback);
    }

    RedisDatabase.prototype.getUserProperties = function (zoneId, userId, propertyNames, callback){
        if (propertyNames && Array.isArray(propertyNames)){
            var keys = propertyNames.map(function(name){return "Zone:" + zoneId + ":User:" + userId + ":" + name;});
            this.redisClient.mget(keys, callback);
        }
        else{
            callback('bad property name', []);
        }
    }

    RedisDatabase.prototype.setUserProperty = function(zoneId, userId, propertyName, value, callback){
        var key = "Zone:" + zoneId + ":User:" + userId + ":" + propertyName;
        this.redisClient.set(key, value, callback);
    };

    RedisDatabase.prototype.getUsersFromZone = function(zoneId, callback){
        var _redisClient = this.redisClient;

        var zoneUserSetKey = "Zone:" + zoneId + ":UserSet";

        _redisClient.smembers(zoneUserSetKey, function(err, userIds){
            if (err || !(userIds instanceof Array) || userIds.length <= 0){
                callback(err, []);
            }
            else{
                var userProperties = ['name', 'status'];
                var multi = _redisClient.multi();
                userIds.forEach((function(userId){
                    multi.mget(userProperties.map(function(property){return "Zone:" + zoneId + ":User:" + userId + ":" + property;}));
                }));
                multi.exec(function(err, replies){
                    if (!err && userIds.length === replies.length){
                        var index = 0;
                        var users = userIds.map(function(userId){
                            var user = {
                                id : userId
                            }
                            for (var i in userProperties){
                                user[userProperties[i]] = replies[index][i];
                            }
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

    RedisDatabase.prototype.getZonesFromUser = function(userId, callback){
        var _redisClient = this.redisClient;

        var userZoneSetKey = "User:" + userId + ":ZoneSet";

        _redisClient.smembers(userZoneSetKey, function(err, zoneIds){
            if (err || !(zoneIds instanceof Array) || zoneIds.length <= 0){
                callback(err, []);
            }
            else{
                var multi = _redisClient.multi();
                zoneIds.forEach(function(item){multi.hgetall('ZoneHash:'+item);});
                multi.exec(function(err, replies){
                    if (err){
                        callback(err, replies);
                    }
                    else{
                        if (zoneIds.length === replies.length){
                            for (var i = 0; i < zoneIds.length; ++i){
                                replies[i]['id'] = zoneIds[i];
                            }
                        }

                        callback(err, replies);
                    }
                });
            }
        });
    };

    RedisDatabase.prototype.getAllZonesKey = function(callback){
        this.redisClient.smembers("ZoneSet", callback);
    };

    RedisDatabase.prototype.addTalkHistory = function(zoneId, talk, callback){
        var zoneHistoryKey = "Zone:" + zoneId + ":HistoryList";
        var talkJson = JSON.stringify(talk);
        this.redisClient
            .multi()
            .lpush(zoneHistoryKey, talkJson)
            .ltrim(zoneHistoryKey, 0, 100)
            .exec(callback);
    };

    RedisDatabase.prototype.getTalkHistory = function(zoneId, callback){
        var zoneHistoryKey = "Zone:" + zoneId + ":HistoryList";
        this.redisClient.lrange(zoneHistoryKey, 0, 100, function(err, talkJsons){
            if (err || !talkJsons || !Array.isArray(talkJsons)){
                callback(err, talkJsons);
            }
            else{
                var talks = talkJsons.map(function(talkJson){return JSON.parse(talkJson);}).reverse();
                callback(err, talks);
            }
        });
    };

//    RedisDatabase.prototype.setUserField = function (userId, setHash, callback){
//        this.setHashField('User', userId, setHash, callback);
//    };
//
//    RedisDatabase.prototype.setZoneField = function (zoneId, setHash, callback){
//        this.setHashField('Zone', zoneId, setHash, callback);
//    };

//    RedisDatabase.prototype.setHashField = function (keyPrefix, hashId, setHash, callback) {
//        if (setHash instanceof Object){
//            var _redisClient = this.redisClient;
//
//            var key = keyPrefix + "Hash:" + hashId;
//
//            var passArg = new Array();
//            passArg.push(key);
//
//            for (var setHashKey in setHash){
//                passArg.push(setHashKey);
//                passArg.push(setHash[setHashKey]);
//            }
//
//            passArg.push(callback);
//
//            _redisClient.hset.apply(this, passArg);
//        }
//        else{
//            callback("need set hash.", null);
//        }
//    };
//
//    RedisDatabase.prototype.getOrCreateHash = function (keyPrefix, id, callback) {
//        var _redisClient = this.redisClient;
//        var key = keyPrefix + "Hash:" + id;
//        _redisClient.exists(key, function (err, isExists){
//            if (err) {
//                callback(err, null);
//            }
//
//            if (isExists) {
//                _redisClient.hgetall(key, function (err, hash){
//                    if (!err) {
//                        hash['id'] = id;
//                    }
//
//                    callback(err, hash);
//                });
//            }
//            else {
//                // initial User
//                _redisClient.hmset(key, "createTime", (new Date()).getTime(), function(err, result){
//                    if (err) {
//                        callback(err, result);
//                    }
//                    else{
//                        _redisClient.hgetall(key, function (err, hash){
//                            if (!err) {
//                                hash['id'] = id;
//                            }
//
//                            callback(err, hash);
//                        });
//                    }
//                });
//            }
//        });
//    };

    return RedisDatabase;
})();