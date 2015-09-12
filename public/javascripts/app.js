'use strict';

/* App Module */

angular.module('bongtalkApp', [
	'ngRoute',
	'ngCookies',
	'ngAnimate',
	'ngDialog',
	'luegg.directives',
	'bongtalk.controllers'
])
.config(['$routeProvider',
	function ($routeProvider) {
		$routeProvider
			.when('/', { templateUrl: 'partials/boot.html', controller: 'BootController' })
			.when('/main', { templateUrl: 'partials/main.html', controller: 'MainController' })
			.when('/main/:left', { templateUrl: 'partials/main.html', controller: 'MainController' })
			.when('/main/:left/:right', { templateUrl: 'partials/main.html', controller: 'MainController' })
			.when('/main/:left/:right/:param', { templateUrl: 'partials/main.html', controller: 'MainController' })
			.when('/login', { templateUrl: 'partials/loginDialog.html', controller: 'LoginDialogController' })
			.when('/signout', { templateUrl: 'partials/boot.html', controller: 'SignOutController' })
			.when('/signin', { templateUrl: 'partials/signInDialog.html', controller: 'SignInDialogController' })
			.when('/signup', { templateUrl: 'partials/signUpDialog.html', controller: 'SignUpDialogController' })
			.when('/test', { templateUrl: 'partials/test.html', controller: 'TestController' })
			.otherwise({ redirectTo: '/'});
	}])
.run(['$window', '$rootScope', 'emitter',
	function ($window ,  $rootScope, emitter) {
		$rootScope.goBack = function(){
			$window.history.back();
		}

		// $rootScope.focusLeft = function(){
		// 	emitter.emit('focusArea', false);
		// }

		// $rootScope.focusRight = function(){
		// 	emitter.emit('focusArea', true);
		// }
	}]);