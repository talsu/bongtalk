/**
 * Created by Talsu on 13. 11. 22.
 */
"use strict";

var Guid = require('guid');
var util = require('util');

exports.User = (function () {
    function User(webSocketConnection, username, session) {
        this.connection = webSocketConnection;
        this.id = Guid.create().value;
        this.name = username;
        this.currentZone = null;
        this.session = session;
    }

    User.prototype.sendEvent = function (eventName, data) {
        this.connection.emit(eventName, data);
    };

    User.prototype.changeName = function (newName) {
        this.name = newName;

        if (this.currentZone){
            this.currentZone.sendEvent('changeName', this.getSimpleUser());
        }
    };

    User.prototype.getSimpleUser = function(){
        return {id:this.id, name:this.name};
    };

    return User;
})();

exports.Zone = (function () {
    function Zone(id) {

        if (id === undefined) {
            id = Guid.create().value;
        }

        this.id = id;
        this.users = [];
        this.history = [];
        this.talkCount = 0;
    }

    Zone.prototype.broadcastTalk = function (user, message) {

        var talk = {
            id: this.talkCount,
            time: (new Date()).getTime(),
            message: message,
            user: user.getSimpleUser()
        };

        this.talkCount++;

        this.addHistory(talk);
        this.sendEvent('sendMessage', talk);
    };

    Zone.prototype.sendEvent = function (eventName, data) {
        this.users.forEach(function (user) {
            user.connection.emit(eventName, data);
        });
    };

    Zone.prototype.join = function(user){

        this.sendEvent('newUser', user.getSimpleUser());

        user.sendEvent('sendZoneInfo', {history:this.getHistory(), connectedUsers:this.users.map(
            function(user){
                return user.getSimpleUser();
            }
        )});

        this.users.push(user);

        user.currentZone = this;
    };

    Zone.prototype.leave = function(user){
        var userIndex = null;
        for (var i=0; i < this.users.length; i++) {
            if (this.users[i] === user){
                userIndex = i;
            }
        }

        if  (userIndex !== null){
            this.users.splice(userIndex, 1);

            this.sendEvent('removeUser', user.getSimpleUser());

            user.currentZone = null;
        }
    };

    Zone.prototype.addHistory = function (message) {
        this.history.push(message);
        this.history = this.history.slice(-100);
    };

    Zone.prototype.getHistory = function () {
        return this.history;
    };

    return Zone;
})();
var Zone = exports.Zone;

exports.Zones = (function () {
    function Zones() {
        this.zones = {};
    }

    Zones.prototype.getZone = function (id) {

        if (this.zones[id] === undefined) {
            console.log('create zone id : ' + id);
            this.zones[id] = new Zone(id);
        }

        return this.zones[id];
    };

    return Zones;
})();

exports.RedisZone = (function() {
    function RedisZone(id) {

        if (id === undefined) {
            id = Guid.create().value;
        }

        this.id = id;
        this.users = [];
        this.history = [];
        this.talkCount = 0;
    }
})();

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

    RedisZones.prototype.addUser = function (user, callback) {
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

    RedisZones.prototype.jadeGetZones = function(){
        var result = [];
        for (var zoneKey in this.zones){
            result.push({id:zoneKey});
        }
        return result;
    };

    RedisZones.prototype.jadeGetUsers = function(zoneId){
        var result = [];
        var index = 0;
        if (this.zones.hasOwnProperty(zoneId)){
            for (var userKey in this.zones[zoneId].users){
                var user = this.zones[zoneId].users[userKey];
                user.connectedThisInstance = this.userSockets.hasOwnProperty(userKey);
                user.index = index;
                index++;
                result.push(user);
            }
        }
        return result;
    };

    return RedisZones;
})();