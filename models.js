/**
 * Created by Talsu on 13. 11. 22.
 */
"use strict";

var util = require('util');

exports.RedisZones = (function(){
    function RedisZones(redisClient){
        this.redisClient = redisClient;
        this.zones = new Object();
        this.notJoinedUsers = new Object();
        this.userSockets = new Object();
    };

    RedisZones.prototype.addUserSocket = function (userId, socket) {
        this.userSockets[userId] = socket;
    };

    RedisZones.prototype.removeUserSocket = function(userId) {
        if (this.userSockets.hasOwnProperty(userId)){
            delete this.userSockets[userId];
        }
    };

    RedisZones.prototype.setUserField = function (userId, field, value, callback) {
        var redisClient = this.redisClient;
        var key = "UserHash:" + userId;
        redisClient.hset(key, field, value, callback);
    };

    RedisZones.prototype.getZone = function (id, callback) {
        var redisClient = this.redisClient;
        var key = "ZoneHash:" + id;
        redisClient.exists(key, function (err, isExists){
            if (err) {
                callback(err, null);
            }

            if (isExists) {
                redisClient.hgetall(key, function (err, hash){
                    callback(err, hash);
                });
            }
            else {
                redisClient.hmset(key, "totalMessageCount", 0, function(err, result){
                   callback(err, result);
                });
            }
        });
    };

    RedisZones.prototype.joinZone = function (zoneId, userId, userName, callback) {
        var redisClient = this.redisClient;
        var key = "UserHash:" + userId;
        redisClient.hmset(key, 'currentZoneId', zoneId, 'name', userName, function (err, result){
            callback(err, result);
        });
    };

    RedisZones.prototype.leaveZone = function (userId, callback) {
        var redisClient = this.redisClient;
        var key = "UserHash:" + userId;
        redisClient.hget(key, 'currentZoneId', function(err, currentZoneId){
            if (err) {
                callback(err, null);
            }

            redisClient.hdel(key, 'currentZoneId', function (err, result){
                if (err) {
                    callback(err, null);
                }
                else {
                    callback(err, currentZoneId);
                }
            });
        });

    };

    RedisZones.prototype.getOrCreateUser = function (id, callback) {
        var redisClient = this.redisClient;
        var key = "UserHash:" + id;
        redisClient.exists(key, function (err, isExists){
            if (err) {
                callback(err, null);
            }

            if (isExists) {
                redisClient.hgetall(key, function (err, hash){
                    if (!err) {
                        hash['id'] = id;
                    }

                    callback(err, hash);
                });
            }
            else {
                // initial User
                redisClient.hmset(key, "createTime", (new Date()).getTime(), function(err, result){
                    if (err) {
                        callback(err, result);
                    }
                    else{
                        redisClient.hgetall(key, function (err, hash){
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

    RedisZones.prototype.addUser = function (user) {
        if (user.currentZoneId){
            if (!this.zones.hasOwnProperty(user.currentZoneId)){
                this.zones[user.currentZoneId] = new Object({users : new Object()});
            }
            if (this.notJoinedUsers[user.id]){
                delete this.notJoinedUsers[user.id];
            }

            this.zones[user.currentZoneId].users[user.id] = user;


            for (var userId in this.zones[user.currentZoneId].users){
                if (this.userSockets.hasOwnProperty(userId)){
                    if (userId !== user.id){
                        // for exsists user
                        this.userSockets[userId].emit('newUser', user);
                    }
                }
            }
        }
        else{
            this.notJoinedUsers[user.id] = user;
        }
    };

    RedisZones.prototype.removeUser = function(zoneId, userId){
        if (zoneId && this.zones[zoneId] && this.zones[zoneId] && this.zones[zoneId].users[userId]){
            for (var userKey in this.zones[zoneId].users){
                if (userKey !== userId && this.userSockets.hasOwnProperty(userKey)){
                    this.userSockets[userKey].emit('removeUser', {id: userId});
                }
            }

            delete this.zones[zoneId].users[userId];

            if (Object.keys(this.zones[zoneId].users).length == 0){
                util.log("Delete Zone : " + zoneId);
                delete this.zones[zoneId];
            }
        }
    };

    RedisZones.prototype.changeName = function(zoneId, userId, userName){
        if (zoneId && this.zones[zoneId] && this.zones[zoneId] && this.zones[zoneId].users[userId]){
            this.zones[zoneId].users[userId].name = userName;
        }
    };

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