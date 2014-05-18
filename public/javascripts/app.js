'use strict';

define(['angular', 'zeroClipboard', 'angularRoute', 'route', 'scrollglue', 'ngClip'],
function(angular, zeroClipboard){
	var app = angular.module('bongtalkApp', ['ngRoute', 'appControllers', 'luegg.directives', 'ngClipboard']);

	app.config(['ngClipProvider', function(ngClipProvider) {
		window.ZeroClipboard = zeroClipboard;
		ngClipProvider.setPath("../bower_components/zeroclipboard/ZeroClipboard.swf");
	}]);

	return app;
});
