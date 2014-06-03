'use strict';

requirejs.config({
	// baseUrl: 'bower_components',
	paths:{
		underscore : '../bower_components/underscore/underscore',
		jquery : '../bower_components/jquery/dist/jquery',
		angular : '../bower_components/angular/angular',
		angularRoute : '../bower_components/angular-route/angular-route',
		scrollglue : '../bower_components/angularjs-scroll-glue/src/scrollglue',
		zeroClipboard : '../bower_components/zeroclipboard/ZeroClipboard',
		ngClip : '../bower_components/ng-clip/dest/ng-clip',
		bootstrap : '../bower_components/bootstrap/dist/js/bootstrap',
		socket : '../bower_components/socket.io-client/socket.io',
		eventEmitter : '../bower_components/eventEmitter/EventEmitter'
	},
	shim:{
		angular:{
			deps:['jquery'],
			exports:'angular'
		},
		angularRoute:{
			deps:['angular'],
			exports:'angularRoute'
		},
		scrollglue:{
			deps:['angular'],
			exports:'scrollglue'
		},
		zeroClipboard:{
			deps:['angular'],
			exports: 'ZeroClipboard'
		},		
		ngClip:{
			deps:['zeroClipboard']
		},
		bootstrap:{
			deps:['jquery']
		}		
	}
});

requirejs(['app'], function(app){		
	$(document).ready(function(){
		angular.bootstrap(document, ['bongtalkApp']);
	});	
});
