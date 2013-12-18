/**
 * Created by Talsu on 13. 11. 22.
 */
"use strict";

var util = require('util');

exports.RedisZones = (function(){
    function RedisZones(redisClient){
//        this.zones = new Object();
//        this.notJoinedUsers = new Object();
//        this.userSockets = new Object();
        this.database = new exports.RedisDatabase(redisClient);
    };

//    RedisZones.prototype.addUserSocket = function (userId, socket) {
//        if (!this.userSockets.hasOwnProperty(userId)){
//            this.userSockets[userId] = new Object({sockets:[]});
//        }
//        this.userSockets[userId].sockets.push(socket);
//    };

//    RedisZones.prototype.removeUserSocket = function(userId) {
//        if (this.userSockets.hasOwnProperty(userId)){
//            delete this.userSockets[userId];
//        }
//    };

    RedisZones.prototype.getZone = function (id, callback) {
        this.database.getOrCreateZone(id, callback);
    };

    RedisZones.prototype.joinZone = function (zoneId, userId, userName, callback) {
        var _database = this.database;
        _database.getOrCreateZone(zoneId, function(err, zone){
            if (err){
                callback(err, null);
            }
            else{
                _database.addUserToZone(zoneId, userId, userName, callback);
            }
        });
    };

    RedisZones.prototype.leaveZone = function (zoneId, userId, callback) {
        this.database.removeUserFromZone(zoneId, userId, callback);
    };

    RedisZones.prototype.getOrCreateUser = function (id, callback) {
        this.database.getOrCreateUser(id, callback);
    };

//    RedisZones.prototype.addUser = function (zoneId, userId) {
//        this.database.getUserName(zoneId, userId, function(err, userName){
//            for (var userKey in this.zones[zoneId].users){
//                if (this.userSockets.hasOwnProperty(userId)){
//                    if (userId !== user.id){
//                        // for exsists user
//                        this.userSockets[userId].emit('newUser', user);
//                    }
//                }
//            }
//        });
//    };
//
//    RedisZones.prototype.removeUser = function(zoneId, userId){
//        if (zoneId && this.zones[zoneId] && this.zones[zoneId] && this.zones[zoneId].users[userId]){
//            for (var userKey in this.zones[zoneId].users){
//                if (userKey !== userId && this.userSockets.hasOwnProperty(userKey)){
//                    this.userSockets[userKey].emit('removeUser', {id: userId});
//                }
//            }
//
//            delete this.zones[zoneId].users[userId];
//
//            if (Object.keys(this.zones[zoneId].users).length == 0){
//                util.log("Delete Zone : " + zoneId);
//                delete this.zones[zoneId];
//            }
//        }
//    };

//    RedisZones.prototype.changeName = function(zoneId, userId, userName){
//        if (zoneId && this.zones[zoneId] && this.zones[zoneId] && this.zones[zoneId].users[userId]){
//            this.zones[zoneId].users[userId].name = userName;
//        }
//    };

    RedisZones.prototype.eventToZone = function (event) {
        if (this.zones.hasOwnProperty(event.zoneId)){
            for (var userId in this.zones[event.zoneId].users){
                if (this.userSockets.hasOwnProperty(userId)){
                    this.userSockets[userId].emit(event.eventName, event.message);
                }
            }
        }
    };

    RedisZones.prototype.eventToUser = function (event) {
        if (this.zones.hasOwnProperty(event.zoneId)
            && this.zones[event.zoneId].users.hasOwnProperty(event.userId)
            && this.userSockets.hasOwnProperty(event.userId))
        {
            this.userSockets[event.userId].emit(event.eventName, event.message);
        }
    };

    return RedisZones;
})();

exports.JadeDataBinder = (function(){
    function JadeDataBinder(bongtalk){
        this.bongtalk = bongtalk;
        this.redisZones = bongtalk.redisZones;
    };

    JadeDataBinder.prototype.getZones = function(){
        var result = [];
        for (var zoneKey in this.redisZones.zones){
            result.push({id:zoneKey});
        }
        return result;
    };
    JadeDataBinder.prototype.getUsers = function(zoneId){
        var result = [];
        var index = 0;
        if (this.redisZones.zones.hasOwnProperty(zoneId)){
            for (var userKey in this.redisZones.zones[zoneId].users){
                var user = this.redisZones.zones[zoneId].users[userKey];
                user.connectedThisInstance = this.redisZones.userSockets.hasOwnProperty(userKey);
                user.index = index;
                index++;
                result.push(user);
            }
        }
        return result;
    };


    return JadeDataBinder;
})();

exports.RedisDatabase = (function(){
    function RedisDatabase(redisClient){
        this.redisClient = redisClient;
    };

    RedisDatabase.prototype.getOrCreateUser = function (userId, callback) {
        this.getOrCreateHash('User', userId, callback);
    };

    RedisDatabase.prototype.getOrCreateZone = function (zoneId, callback) {
        this.getOrCreateHash('Zone', zoneId, callback);
    };

    RedisDatabase.prototype.addUserToZone = function (zoneId, userId, userName, callback){
        var _redisClient = this.redisClient;

        var zoneUserSetKey = "Zone:" + zoneId + ":UserSet";
        var userZoneSetKey = "User:" + userId + ":ZoneSet";
        var userNameInZoneKey = "Zone:" + zoneId + ":User:" + userId + ":Name";

        _redisClient
            .multi()
            .sadd(zoneUserSetKey, userId)
            .sadd(userZoneSetKey, zoneId)
            .set(userNameInZoneKey, userName)
            .exec(callback);
    };

    RedisDatabase.prototype.removeUserFromZone = function (zoneId, userId, callback){
        var _redisClient = this.redisClient;

        var zoneUserSetKey = "Zone:" + zoneId + ":UserSet";
        var userZoneSetKey = "User:" + userId + ":ZoneSet";
        var userNameInZoneKey = "Zone:" + zoneId + ":User:" + userId + ":Name";

        _redisClient
            .multi()
            .srem(zoneUserSetKey, userId)
            .srem(userZoneSetKey, zoneId)
            .del(userNameInZoneKey)
            .exec(callback);
    };

    RedisDatabase.prototype.getUserName = function (zoneId, userId, callback){
        var userNameInZoneKey = "Zone:" + zoneId + ":User:" + userId + ":Name";
        this.redisClient.get(userNameInZoneKey, callback);
    }

    RedisDatabase.prototype.setUserName = function (zoneId, userId, userName, callback){
        var userNameInZoneKey = "Zone:" + zoneId + ":User:" + userId + ":Name";
        this.redisClient.set(userNameInZoneKey, userName, callback);
    }

    RedisDatabase.prototype.getUsersFromZone = function(zoneId, callback){
        var _redisClient = this.redisClient;

        var zoneUserSetKey = "Zone:" + zoneId + ":UserSet";

        _redisClient.smembers(zoneUserSetKey, function(err, userIds){
            if (err || !(userIds instanceof Array) || userIds.length <= 0){
                callback(err, []);
            }
            else{
                var multi = _redisClient.multi();
                userIds.forEach(function(item){multi.hgetall('UserHash:'+item);});
                multi.exec(function(err, replies){
                    if (err){
                        callback(err, replies);
                    }
                    else{
                        if (userIds.length === replies.length){
                            for (var i = 0; i < userIds.length; ++i){
                                replies[i]['id'] = userIds[i];
                            }
                        }

                        callback(err, replies);
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

    RedisDatabase.prototype.setUserField = function (userId, setHash, callback){
        this.setHashField('User', userId, setHash, callback);
    };

    RedisDatabase.prototype.setZoneField = function (zoneId, setHash, callback){
        this.setHashField('Zone', zoneId, setHash, callback);
    };

    RedisDatabase.prototype.setHashField = function (keyPrefix, hashId, setHash, callback) {
        if (setHash instanceof Object){
            var _redisClient = this.redisClient;

            var key = keyPrefix + "Hash:" + hashId;

            var passArg = new Array();
            passArg.push(key);

            for (var setHashKey in setHash){
                passArg.push(setHashKey);
                passArg.push(setHash[setHashKey]);
            }

            passArg.push(callback);

            _redisClient.hset.apply(this, passArg);
        }
        else{
            callback("need set hash.", null);
        }
    };

    RedisDatabase.prototype.getOrCreateHash = function (keyPrefix, id, callback) {
        var _redisClient = this.redisClient;
        var key = keyPrefix + "Hash:" + id;
        _redisClient.exists(key, function (err, isExists){
            if (err) {
                callback(err, null);
            }

            if (isExists) {
                _redisClient.hgetall(key, function (err, hash){
                    if (!err) {
                        hash['id'] = id;
                    }

                    callback(err, hash);
                });
            }
            else {
                // initial User
                _redisClient.hmset(key, "createTime", (new Date()).getTime(), function(err, result){
                    if (err) {
                        callback(err, result);
                    }
                    else{
                        _redisClient.hgetall(key, function (err, hash){
                            if (!err) {
                                hash['id'] = id;
                            }

                            callback(err, hash);
                        });
                    }
                });
            }
        });
    };

    return RedisDatabase;
})();