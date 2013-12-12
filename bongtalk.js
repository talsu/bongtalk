"use strict";
/**
 * Module dependencies.
 */

var routes = require('./routes');
var user = require('./routes/user');
var express = require('express');
var http = require('http');
var path = require('path');
var util = require('util');
var redis = require("redis");

var RedisStore = require('connect-redis')(express);
var SessionSockets = require('session.socket.io');

exports.BongTalk = (function () {
    function BongTalk(servicePort) {
        this.servicePort = servicePort;
        this.redisClient = null;
        this.sessionStore = null;
    }

    BongTalk.prototype.start = function (){
        this.setRedis();

        var app = express();

// all environments
        app.set('port', process.env.PORT || this.servicePort);
        app.set('views', path.join(__dirname, 'views'));
        app.set('view engine', 'jade');
        app.use(express.favicon());
        app.use(express.logger('dev'));
        app.use(express.json());
        app.use(express.urlencoded());
        app.use(express.methodOverride());
        app.use(app.router);
        app.use(express.static(path.join(__dirname, 'public')));
        if (this.sessionStore){
            app.use(express.session({store: this.sessionStore, key: 'jsessionid', secret: 'your secret here'}));
        }


        var cookieParser = express.cookieParser('your secret here');
        app.use(cookieParser);
// development only
        if ('development' === app.get('env')) {
            app.use(express.errorHandler());
        }

        app.get('/', routes.index);
        app.get('/users', user.list);
        app.get('/getCookie', function(req, res){
           res.send(req.cookies);
        });

        var server = http.createServer(app);

        var io = require('socket.io').listen(server);


        var sessionSockets = new SessionSockets(io, this.sessionStore, cookieParser, 'jsessionid');

        server.listen(app.get('port'), function () {
            util.log('Server listening on port ' + app.get('port'));
        });

        var models = require('./models');
        var User = models.User;
        var Zones = models.Zones;
        var zones = new Zones();

//        io.sockets.on('connection', function (socket) {
        sessionSockets.on('connection', function(err, socket, session){

            util.log(util.inspect(err));
            util.log(util.inspect(session));

            //create user
            var user = new User(socket, socket.id);

            //sendProfile
            socket.emit('sendProfile', user.getSimpleUser());
            socket.on('joinZone', function(data) {
                user.name = data.user.name;
                zones.getZone(data.zoneId).join(user);
            });

            socket.on('sendMessage', function(data){
                if (user.currentZone) {
                    user.currentZone.broadcastTalk(user, data);
                }
            });

            socket.on('changeName', function(data){
                user.changeName(data);
            });

            socket.on('disconnect', function(){
                util.log(" Peer " + user.name + " disconnected.");
                if (user.currentZone) {
                    user.currentZone.leave(user);
                }
            });
        });
    };

    BongTalk.prototype.setRedis = function(){
        try
        {
            if (process.env.REDISTOGO_URL) {
                // TODO: redistogo connection
                // inside if statement
                var rtg   = require("url").parse(process.env.REDISTOGO_URL);
                this.redisClient = redis.createClient(rtg.port, rtg.hostname);

                this.redisClient.auth(rtg.auth.split(":")[1]);
            } else {
//            this.redisClient = redis.createClient();
                var rtg   = require("url").parse('redis://redistogo:40fcc23419a7cbcb0de7a0da111bda7b@albacore.redistogo.com:9125/');
                this.redisClient = redis.createClient(rtg.port, rtg.hostname);

                this.redisClient.auth(rtg.auth.split(":")[1]);
            }


            this.sessionStore = new RedisStore({client:this.redisClient});
        }
        catch (ex){

        }

    };

    return BongTalk;
})();





