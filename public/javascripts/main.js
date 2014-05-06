'use strict';

requirejs.config({
	// baseUrl: 'bower_components',
	paths:{
		underscore : '../bower_components/underscore/underscore',
		jquery : '../bower_components/jquery/dist/jquery',
		angular : '../bower_components/angular/angular',
		bootstrap : '../bower_components/bootstrap/dist/bootstrap',
		socket : '../bower_components/socket.io-client/dist/socket.io'
	},
	shim:{
		'angular':{
			deps:['jquery'],
			exports:'angular'
		},
		'bootstrap':{
			deps:['jquery'],
			exports:'bootstrap'
		}
	}
});

requirejs(['underscore', 'jquery', 'angular', 'socket', 'app'],
	function(_, $, angular, io){
		$(document).ready(function(){
			angular.bootstrap(document);

			var socket = io.connect('http://localhost:3000');
			socket.on('test', function(data){
				console.log(data);
				socket.emit('test2', {my : data});
			});
		});
	});
